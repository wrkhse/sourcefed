import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { InMemoryMonitorStore, MonitorService } from "@sourcefed/core"
import type { MonitorContext } from "@sourcefed/core"
import { defineSource, type Http, type SourceContext, type SourceDefinition } from "@sourcefed/sdk"
import * as v from "valibot"

const FakeSourceSchema = v.object({
  type: v.literal("fake"),
  channel: v.string(),
})

type FakeSource = v.InferOutput<typeof FakeSourceSchema>

const input = {
  description: "A fake source",
  properties: { channel: { type: "string", description: "Channel name" } },
  required: ["channel"],
}

const testHttp: Http = {
  fetch: async () => {
    throw new Error("the fake source makes no requests")
  },
  json: async () => {
    throw new Error("the fake source makes no requests")
  },
}

const testNow = () => new Date("2026-11-18T09:30:00.000Z")
const testHost = { http: testHttp, now: testNow }

function fakeDefinition(calls: SourceContext<FakeSource>[] = []): SourceDefinition<FakeSource> {
  return {
    type: "fake",
    schema: FakeSourceSchema,
    input,
    build: (create) => (create.channelId ? { type: "fake", channel: create.channelId } : { error: "channelId is required for a fake monitor" }),
    key: (source) => `fake:${source.channel}`,
    label: (source) => source.channel,
    detail: (source) => ` #${source.channel}`,
    describe: (source) => `Fake ${source.channel}`,
    icon: "󰍡",
    poll: async (context) => {
      calls.push(context)
      return { events: [], cursor: "next", terminal: false }
    },
  }
}

describe("defineSource", () => {
  test("returns a Monitor that reads the definition", () => {
    const monitor = defineSource(fakeDefinition(), testHost)
    const source = monitor.validateSource({ type: "fake", channel: "general" })

    assert.equal(monitor.type, "fake")
    assert.equal(monitor.key(source), "fake:general")
    assert.equal(monitor.label(source), "general")
    assert.equal(monitor.detail(source), " #general")
    assert.equal(monitor.describe(source), "Fake general")
    assert.equal(monitor.icon, "󰍡")
    assert.deepEqual(monitor.input, input)
    assert.deepEqual(monitor.build({ channelId: "general" }), { type: "fake", channel: "general" })
  })

  test("refuses a source the schema rejects", () => {
    const monitor = defineSource(fakeDefinition(), testHost)

    assert.throws(() => monitor.validateSource({ type: "fake", channel: 7 }), { message: "invalid fake monitor source" })
  })

  test("a definition's wake is the monitor's wake", () => {
    const wake = { path: "/webhooks/fake", matches: () => true }
    const monitor = defineSource({ ...fakeDefinition(), wake }, testHost)

    assert.equal(monitor.wake, wake)
  })

  test("a definition without a wake leaves the monitor's wake undefined", () => {
    const monitor = defineSource(fakeDefinition(), testHost)

    assert.equal(monitor.wake, undefined)
  })

  test("polls with the source, cursor, monitor id and host http and clock", async () => {
    const calls: SourceContext<FakeSource>[] = []
    const monitor = defineSource(fakeDefinition(calls), testHost)
    const store = new InMemoryMonitorStore({
      monitors: [
        {
          id: "m-sdk",
          name: "sdk",
          source: { type: "fake", channel: "general" },
          delivery: "poll",
          target: { kind: "test-session", id: "session-1" },
          pollIntervalSec: 60,
          enabled: true,
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
          cursors: { "fake:general": "cursor-1" },
        },
      ],
    })
    const service = new MonitorService(store)
    const record = await service.get("m-sdk")
    assert.ok(record)

    const context: MonitorContext = {
      service,
      sink: { deliver: async () => ({ ok: true }) },
      sources: { fake: monitor },
      sourceForWebhookPath: () => undefined,
    }

    const poll = monitor.poll
    assert.ok(poll)
    assert.equal(await poll.run(context, monitor, record), 0)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].source.channel, "general")
    assert.equal(calls[0].cursor, "cursor-1")
    assert.equal(calls[0].monitorId, "m-sdk")
    assert.equal(calls[0].http, testHttp)
    assert.equal(calls[0].now, testNow)

    const after = await service.get("m-sdk")
    assert.equal(after?.cursors["fake:general"], "next")
  })
})
