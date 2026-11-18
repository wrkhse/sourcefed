import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { assertGolden, withEnvironment, type GoldenFixture, type GoldenWebhookCase } from "@sourcefed/sdk"
import type { SourceDefinition, SourceWebhook } from "@sourcefed/sdk"
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

  test("serves a text reply as its plain body", async () => {
    const [first] = fixture.cases
    const logged: SourceDefinition<FakeSource> = {
      ...definition,
      poll: async ({ source, http }) => {
        const response = await http.fetch(`https://fake.test/${source.channel}/log`)

        return {
          events: [],
          cursor: { type: response.headers.get("content-type"), text: await response.text() },
          terminal: false,
        }
      },
    }
    const plain: GoldenFixture = {
      ...fixture,
      cases: [
        {
          ...first,
          name: "log",
          replies: [{ text: "not ok 1\nexit code 1" }],
          requests: [{ method: "GET", url: "https://fake.test/general/log", headers: {} }],
          events: [],
          cursorAfter: { type: "text/plain; charset=utf-8", text: "not ok 1\nexit code 1" },
        },
      ],
    }

    await assertGolden(plain, logged)
  })

  test("records a string request body and holds the replay to it", async () => {
    const [first] = fixture.cases
    const graphql: SourceDefinition<FakeSource> = {
      ...definition,
      poll: async ({ source, http }) => {
        await http.json("https://fake.test/graphql", { method: "POST", body: JSON.stringify({ query: `{ channel(name: "${source.channel}") { id } }` }) })

        return { events: [], cursor: ["1"], terminal: false }
      },
    }
    const posted: GoldenFixture = {
      ...fixture,
      cases: [
        {
          ...first,
          name: "graphql",
          replies: [{ status: 200, body: { data: { channel: { id: "1" } } } }],
          requests: [{ method: "POST", url: "https://fake.test/graphql", headers: {}, body: "{\"query\":\"{ channel(name: \\\"general\\\") { id } }\"}" }],
          events: [],
        },
      ],
    }

    await assertGolden(posted, graphql)

    const [kase] = posted.cases
    const otherBody: GoldenFixture = { ...posted, cases: [{ ...kase, requests: [{ ...kase.requests[0], body: "{}" }] }] }

    await assert.rejects(assertGolden(otherBody, graphql), /fake graphql: requests/)
  })

  test("gives each case its own instant over the fixture's", async () => {
    const [first] = fixture.cases
    const stamped: SourceDefinition<FakeSource> = {
      ...definition,
      poll: async ({ source, now }) => ({
        events: [{ source, kind: "message", id: "1", at: now().toISOString(), summary: "hello", actionable: true }],
        cursor: ["1"],
        terminal: false,
      }),
    }
    const event = (at: string) => ({ source: { type: "fake", channel: "general" }, kind: "message", id: "1", at, summary: "hello", actionable: true })
    const minutesApart: GoldenFixture = {
      ...fixture,
      now: "2026-11-18T08:00:00.000Z",
      cases: [
        { ...first, name: "first poll", now: "2026-11-18T08:15:00.000Z", replies: [], requests: [], events: [event("2026-11-18T08:15:00.000Z")] },
        { ...first, name: "second poll", now: "2026-11-18T08:20:00.000Z", replies: [], requests: [], events: [event("2026-11-18T08:20:00.000Z")] },
      ],
    }

    await assertGolden(minutesApart, stamped)

    const [, second] = minutesApart.cases
    const { now: _ownInstant, ...atFixture } = second
    const fixtureClock: GoldenFixture = { ...minutesApart, cases: [atFixture] }

    await assert.rejects(assertGolden(fixtureClock, stamped), /fake second poll: events/)
  })
})

// A signature is the body behind a timestamp, and it is stale more than five minutes either side of the host's clock.
const webhook: SourceWebhook = {
  path: "/webhooks/fake",
  preferred: true,
  configured: () => true,
  acknowledgeBeforeDelivery: true,
  verify: (body, request, now) => {
    const sentAt = Date.parse(request.headers.get("x-fake-timestamp") ?? "")
    const fresh = Math.abs(now().getTime() - sentAt) <= 5 * 60_000

    return fresh && request.headers.get("x-fake-signature") === `sig:${body}`
  },
  challenge: (payload) => {
    const body = payload as { type?: string; challenge?: string }

    return body.type === "url_verification" && body.challenge ? { challenge: body.challenge } : undefined
  },
  deliveryId: (_request, payload) => (payload as { id?: string }).id,
  eventName: (request) => request.headers.get("x-fake-event") ?? "fake",
  parse: (payload, eventName, deliveryId, now) => {
    const body = payload as { channel: string; text: string }

    return {
      source: { type: "fake", channel: body.channel },
      kind: eventName,
      id: deliveryId,
      at: now().toISOString(),
      summary: body.text,
      actionable: true,
    }
  },
  updateCursor: (event, cursor) => [...(Array.isArray(cursor) ? cursor : []), event.id],
}

function signed(body: string, sentAt = "2026-11-18T08:14:00.000Z"): Record<string, string> {
  return { "x-fake-timestamp": sentAt, "x-fake-signature": `sig:${body}`, "x-fake-event": "message" }
}

const messageBody = JSON.stringify({ id: "d-1", channel: "general", text: "hello" })
const lateBody = JSON.stringify({ id: "d-2", channel: "general", text: "later" })
const challengeBody = JSON.stringify({ type: "url_verification", challenge: "abc" })

const webhookCases: GoldenWebhookCase[] = [
  {
    name: "stale signature",
    headers: signed(messageBody, "2026-11-18T08:00:00.000Z"),
    body: messageBody,
    cursor: null,
    verified: false,
  },
  {
    name: "challenge",
    headers: signed(challengeBody),
    body: challengeBody,
    cursor: null,
    verified: true,
    challenge: { challenge: "abc" },
  },
  {
    name: "message",
    headers: signed(messageBody),
    body: messageBody,
    cursor: ["d-0"],
    verified: true,
    challenge: null,
    deliveryId: "d-1",
    eventName: "message",
    event: {
      source: { type: "fake", channel: "general" },
      kind: "message",
      id: "d-1",
      at: "2026-11-18T08:15:00.000Z",
      summary: "hello",
      actionable: true,
    },
    cursorAfter: ["d-0", "d-1"],
  },
  {
    // Signed and checked at its own instant, an hour after the fixture's, when it is fresh.
    name: "late",
    now: "2026-11-18T09:16:00.000Z",
    headers: signed(lateBody, "2026-11-18T09:15:00.000Z"),
    body: lateBody,
    cursor: ["d-0", "d-1"],
    verified: true,
    challenge: null,
    deliveryId: "d-2",
    eventName: "message",
    event: {
      source: { type: "fake", channel: "general" },
      kind: "message",
      id: "d-2",
      at: "2026-11-18T09:16:00.000Z",
      summary: "later",
      actionable: true,
    },
    cursorAfter: ["d-0", "d-1", "d-2"],
  },
]

const webhookFixture: GoldenFixture = {
  ...fixture,
  now: "2026-11-18T08:15:00.000Z",
  cases: [],
  webhook: { path: "/webhooks/fake", preferred: true, acknowledgeBeforeDelivery: true, configured: true, cases: webhookCases },
}

describe("assertGolden webhooks", () => {
  test("replays recorded deliveries step by step at the recorded instant", async () => {
    await assertGolden(webhookFixture, { ...definition, webhook })
  })

  test("names the provider and case when a delivery's event differs", async () => {
    const [stale, challenge, message] = webhookCases
    const mismatched: GoldenFixture = {
      ...webhookFixture,
      webhook: {
        path: "/webhooks/fake",
        preferred: true,
        acknowledgeBeforeDelivery: true,
        configured: true,
        cases: [stale, challenge, { ...message, event: { ...(message.event as object), summary: "different" } }],
      },
    }

    await assert.rejects(assertGolden(mismatched, { ...definition, webhook }), /fake webhook message/)
  })

  test("verifies a delivery at its own instant, where the fixture's would find it stale", async () => {
    const { now: _ownInstant, ...late } = webhookCases[3]
    const atFixture: GoldenFixture = {
      ...webhookFixture,
      webhook: { path: "/webhooks/fake", preferred: true, acknowledgeBeforeDelivery: true, configured: true, cases: [late] },
    }

    await assert.rejects(assertGolden(atFixture, { ...definition, webhook }), (error: Error) => {
      assert.match(error.message, /fake webhook late/)
      // Stale at the fixture's instant, so the replay stops at verification.
      assert.equal((error as { actual?: { verified?: boolean } }).actual?.verified, false)
      return true
    })
  })

  test("fails when the fixture has a webhook and the definition has none", async () => {
    await assert.rejects(assertGolden(webhookFixture, definition), /fake webhook: missing/)
  })
})

describe("withEnvironment", () => {
  const present = "SOURCEFED_SDK_TEST_PRESENT"
  const absent = "SOURCEFED_SDK_TEST_ABSENT"

  test("sets and removes variables for the run, then restores them", async () => {
    process.env[present] = "before"
    delete process.env[absent]

    try {
      const seen = await withEnvironment({ [present]: undefined, [absent]: "during" }, async () => [process.env[present], process.env[absent]])

      assert.deepEqual(seen, [undefined, "during"])
      assert.equal(process.env[present], "before")
      assert.equal(absent in process.env, false)
    } finally {
      delete process.env[present]
    }
  })

  test("restores them when the run throws", async () => {
    process.env[present] = "before"
    delete process.env[absent]

    try {
      const run = withEnvironment({ [present]: "during", [absent]: "during" }, async () => {
        throw new Error("run failed")
      })

      await assert.rejects(run, { message: "run failed" })
      assert.equal(process.env[present], "before")
      assert.equal(absent in process.env, false)
    } finally {
      delete process.env[present]
    }
  })
})
