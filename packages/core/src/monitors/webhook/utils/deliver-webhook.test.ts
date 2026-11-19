import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as v from "valibot"
import { Monitor, MonitorService, WebhookMonitor, type MonitorRecord } from "#sourcefed/monitors"
import type { MonitorSourceRegistry } from "#sourcefed/sources"
import type { MonitorContext, MonitorEvent, MonitorEventSink } from "#sourcefed/types"
import { InMemoryMonitorStore } from "../../../storage/in-memory-monitor-store.ts"
import { deliverWebhook } from "./deliver-webhook.ts"
import { heartbeatWebhooks } from "./heartbeat-webhooks.ts"

type AlphaSource = { type: "alpha"; key: string }
type BetaSource = { type: "beta"; key: string }

const alphaSchema = v.object({ type: v.literal("alpha"), key: v.string() })
const betaSchema = v.object({ type: v.literal("beta"), key: v.string() })

class TestMonitor<T extends { type: string; key: string }> extends Monitor<T> {
  readonly key = (source: T): string => source.key
  readonly input = { description: "A test source", properties: {}, required: [] }
  readonly icon = "?"
  readonly label = (source: T): string => source.key
  readonly detail = (): string => ""
  readonly describe = (source: T): string => `${source.type}:${source.key}`
  readonly webhook: WebhookMonitor<T>

  constructor(type: T["type"], schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, matches?: WebhookMonitor<T>["matches"]) {
    super({ type, schema })
    this.webhook = new WebhookMonitor<T>({
      path: `/webhooks/${type}`,
      configured: () => true,
      verify: () => true,
      deliveryId: () => "d1",
      eventName: () => "test",
      parse: () => undefined,
      matches,
    })
  }

  build(): T {
    return { type: this.type, key: "key" } as T
  }
}

function event(source: unknown, overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    source,
    kind: "comment",
    id: "e1",
    at: "2026-08-04T12:00:00.000Z",
    summary: "test event",
    actionable: true,
    ...overrides,
  }
}

function context(service: MonitorService, sink: MonitorEventSink, sources: MonitorSourceRegistry): MonitorContext {
  return { service, sink, sources, sourceForWebhookPath: () => undefined }
}

async function createRecord(service: MonitorService, type: string, key: string): Promise<MonitorRecord> {
  return (await service.create({
    name: `${type}-${key}`,
    source: { type, key },
    delivery: "webhook",
    target: { kind: "test", id: `session-${type}-${key}` },
    pollIntervalSec: 60,
  })).monitor
}

function recordingSink(delivered: string[]): MonitorEventSink {
  return {
    deliver: async ({ monitor }) => {
      delivered.push(`${monitor.source.type}:${String(monitor.source.key)}`)
      return { ok: true }
    },
  }
}

/** The webhook path owner reaches core as the base Monitor, as sourceForWebhookPath returns it. */
function pathSource<T extends { type: string; key: string }>(monitor: Monitor<T>): Monitor {
  return monitor as unknown as Monitor
}

describe("webhook source-type routing", () => {
  test("a cross-type event routes to the event-type monitors, not the path-source monitors", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const alpha = new TestMonitor<AlphaSource>("alpha", alphaSchema)
    const beta = new TestMonitor<BetaSource>("beta", betaSchema)
    const delivered: string[] = []
    const current = context(service, recordingSink(delivered), { alpha, beta })
    await createRecord(service, "alpha", "key-1")
    await createRecord(service, "beta", "key-1")

    assert.equal(await deliverWebhook(current, pathSource(alpha), event({ type: "beta", key: "key-1" }), "d1"), 1)
    assert.deepEqual(delivered, ["beta:key-1"])
  })

  test("falls back to the path source when the event source has no registered type", async () => {
    for (const source of [{ key: "key-1" }, { type: "gamma", key: "key-1" }]) {
      const service = new MonitorService(new InMemoryMonitorStore())
      const alpha = new TestMonitor<AlphaSource>("alpha", alphaSchema, (watched, next) => (next.source as { key?: string }).key === watched.key)
      const beta = new TestMonitor<BetaSource>("beta", betaSchema)
      const delivered: string[] = []
      const current = context(service, recordingSink(delivered), { alpha, beta })
      await createRecord(service, "alpha", "key-1")
      await createRecord(service, "beta", "key-1")

      assert.equal(await deliverWebhook(current, pathSource(alpha), event(source), "d1"), 1)
      assert.deepEqual(delivered, ["alpha:key-1"])
    }
  })

  test("a matches predicate gates delivery by its result even when keys are equal", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    let accept = false
    const alpha = new TestMonitor<AlphaSource>("alpha", alphaSchema, () => accept)
    const delivered: string[] = []
    const current = context(service, recordingSink(delivered), { alpha })
    await createRecord(service, "alpha", "key-1")
    const delivery = event({ type: "alpha", key: "key-1" })

    assert.equal(await deliverWebhook(current, pathSource(alpha), delivery, "d1"), 0)
    assert.deepEqual(delivered, [])
    accept = true
    assert.equal(await deliverWebhook(current, pathSource(alpha), delivery, "d2"), 1)
    assert.deepEqual(delivered, ["alpha:key-1"])
  })

  test("without a predicate exact key equality still gates delivery", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const alpha = new TestMonitor<AlphaSource>("alpha", alphaSchema)
    const delivered: string[] = []
    const current = context(service, recordingSink(delivered), { alpha })
    await createRecord(service, "alpha", "key-1")

    assert.equal(await deliverWebhook(current, pathSource(alpha), event({ type: "alpha", key: "other" }), "d1"), 0)
    assert.deepEqual(delivered, [])
    assert.equal(await deliverWebhook(current, pathSource(alpha), event({ type: "alpha", key: "key-1" }), "d2"), 1)
    assert.deepEqual(delivered, ["alpha:key-1"])
  })

  test("heartbeatWebhooks selects the event source type and stamps only same-type monitors with the same key", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const alpha = new TestMonitor<AlphaSource>("alpha", alphaSchema)
    const beta = new TestMonitor<BetaSource>("beta", betaSchema)
    const current = context(service, recordingSink([]), { alpha, beta })
    const alphaRecord = await createRecord(service, "alpha", "key-1")
    const betaRecord = await createRecord(service, "beta", "key-1")
    const betaOther = await createRecord(service, "beta", "key-2")

    await heartbeatWebhooks(current, pathSource(alpha), { type: "beta", key: "key-1" })

    assert.ok((await service.get(betaRecord.id))?.cursors.__webhookHeartbeatAt)
    assert.equal((await service.get(betaOther.id))?.cursors.__webhookHeartbeatAt, undefined)
    assert.equal((await service.get(alphaRecord.id))?.cursors.__webhookHeartbeatAt, undefined)
  })
})
