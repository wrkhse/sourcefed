import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { assertGolden, type GoldenFixture } from "@sourcefed/sdk"
import type { SourceDefinition } from "@sourcefed/sdk"
import * as v from "valibot"

const FakeSourceSchema = v.object({
  type: v.literal("fake"),
  channel: v.string(),
})

type FakeSource = v.InferOutput<typeof FakeSourceSchema>

const definition: SourceDefinition<FakeSource> = {
  type: "fake",
  schema: FakeSourceSchema,
  input: {
    description: "A fake source",
    properties: { channel: { type: "string", description: "Channel name" } },
    required: ["channel"],
  },
  build: (create) => (create.channelId ? { type: "fake", channel: create.channelId } : { error: "channelId is required for a fake monitor" }),
  key: (source) => `fake:${source.channel}`,
  label: (source) => source.channel,
  detail: (source) => ` #${source.channel}`,
  describe: (source) => `Fake ${source.channel}`,
  icon: "󰍡",
  poll: async ({ source, cursor, http }) => {
    // The fake source's one deferral: no request, so nothing is read and nothing moves.
    if (cursor === "wait") return { deferred: true }

    const body = await http.json<{ messages: Array<{ id: string; text: string }> }>(`https://fake.test/${source.channel}`, {
      headers: { accept: "application/json", authorization: "Bearer fake" },
    })
    const seen = Array.isArray(cursor) ? cursor.map(String) : []

    return {
      events: body.messages
        .filter((message) => !seen.includes(message.id))
        .map((message) => ({
          source,
          kind: "message",
          id: message.id,
          at: "2026-11-18T00:00:00.000Z",
          summary: message.text,
          actionable: true,
        })),
      cursor: body.messages.map((message) => message.id),
      terminal: false,
    }
  },
}

const fixture: GoldenFixture = {
  provider: "fake",
  recordedFrom: "0a1a5e7",
  base: "https://fake.test",
  cases: [
    {
      name: "first",
      build: { channelId: "general" },
      cursor: null,
      replies: [{ status: 200, body: { messages: [{ id: "1", text: "hello" }] } }],
      requests: [
        { method: "GET", url: "https://fake.test/general", headers: { accept: "application/json", authorization: "«redacted»" } },
      ],
      source: { type: "fake", channel: "general" },
      key: "fake:general",
      label: "general",
      detail: " #general",
      describe: "Fake general",
      icon: "󰍡",
      schema: {
        description: "A fake source",
        properties: { channel: { type: "string", description: "Channel name" } },
        required: ["channel"],
      },
      events: [
        {
          source: { type: "fake", channel: "general" },
          kind: "message",
          id: "1",
          at: "2026-11-18T00:00:00.000Z",
          summary: "hello",
          actionable: true,
        },
      ],
      cursorAfter: ["1"],
    },
    {
      name: "quiet",
      build: { channelId: "general" },
      cursor: ["1"],
      replies: [{ status: 200, body: { messages: [{ id: "1", text: "hello" }] } }],
      requests: [
        { method: "GET", url: "https://fake.test/general", headers: { accept: "application/json", authorization: "«redacted»" } },
      ],
      source: { type: "fake", channel: "general" },
      key: "fake:general",
      label: "general",
      detail: " #general",
      describe: "Fake general",
      icon: "󰍡",
      schema: {
        description: "A fake source",
        properties: { channel: { type: "string", description: "Channel name" } },
        required: ["channel"],
      },
      events: [],
      cursorAfter: ["1"],
    },
  ],
}

describe("assertGolden", () => {
  test("replays a recorded transcript", async () => {
    await assertGolden(fixture, definition)
  })

  test("names the provider and case when events differ", async () => {
    const [first] = fixture.cases
    const mismatched: GoldenFixture = {
      ...fixture,
      cases: [
        {
          ...first,
          events: [
            {
              source: { type: "fake", channel: "general" },
              kind: "message",
              id: "1",
              at: "2026-11-18T00:00:00.000Z",
              summary: "different",
              actionable: true,
            },
          ],
        },
      ],
    }

    await assert.rejects(assertGolden(mismatched, definition), /fake first: events/)
  })

  test("replays a deferral with no request", async () => {
    const [first] = fixture.cases
    const deferred: GoldenFixture = {
      ...fixture,
      cases: [{ ...first, name: "deferred", cursor: "wait", replies: [], requests: [], events: undefined, cursorAfter: undefined, deferred: true }],
    }

    await assertGolden(deferred, definition)
  })

  test("serves a reply's status and headers through http.fetch", async () => {
    const [first] = fixture.cases
    const conditional: SourceDefinition<FakeSource> = {
      ...definition,
      poll: async ({ source, cursor, http }) => {
        const response = await http.fetch(`https://fake.test/${source.channel}`, { headers: { "if-none-match": String(cursor ?? "") } })

        return { events: [], cursor: { status: response.status, etag: response.headers.get("etag") }, terminal: false }
      },
    }
    const notModified: GoldenFixture = {
      ...fixture,
      cases: [
        {
          ...first,
          name: "not-modified",
          cursor: null,
          replies: [{ status: 304, headers: { etag: "W/\"a\"" }, body: null }],
          requests: [{ method: "GET", url: "https://fake.test/general", headers: { "if-none-match": "" } }],
          events: [],
          cursorAfter: { status: 304, etag: "W/\"a\"" },
        },
      ],
    }

    await assertGolden(notModified, conditional)
  })

  test("gives the source the recorded clock", async () => {
    const [first] = fixture.cases
    const stamped: SourceDefinition<FakeSource> = {
      ...definition,
      poll: async ({ source, now }) => ({
        events: [{ source, kind: "message", id: "1", at: now().toISOString(), summary: "hello", actionable: true }],
        cursor: ["1"],
        terminal: false,
      }),
    }
    const clocked: GoldenFixture = {
      ...fixture,
      now: "2026-11-18T08:15:00.000Z",
      cases: [
        {
          ...first,
          name: "clocked",
          replies: [],
          requests: [],
          events: [
            {
              source: { type: "fake", channel: "general" },
              kind: "message",
              id: "1",
              at: "2026-11-18T08:15:00.000Z",
              summary: "hello",
              actionable: true,
            },
          ],
        },
      ],
    }

    await assertGolden(clocked, stamped)
  })
})
