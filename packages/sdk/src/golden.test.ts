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
      cases: [{ ...first, name: "deferred", cursor: "wait", replies: [], requests: [], events: undefined, cursorAfter: undefined }],
    }

    await assertGolden(deferred, definition)
  })
})
