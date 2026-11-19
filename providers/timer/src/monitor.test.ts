import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { InMemoryMonitorStore, MonitorRuntime, type MonitorCreateInput, type MonitorEvent, type MonitorEventSink, type MonitorStore } from "@sourcefed/core"
import { defineSource, type Http, type Mcp } from "@sourcefed/sdk"
import { timerSource } from "./monitor.ts"
import type { TimerCreateInput, TimerSource } from "./schema.ts"

// Neither is called: a timer reads only the clock.
const http = {} as Http
const mcp = {} as Mcp

// 15:00 in Kolkata.
const created = new Date("2026-11-19T09:30:00Z")

// Core's create input names in, at and every once the daemon is wired; until then the cast stands in.
function input(fields: TimerCreateInput): MonitorCreateInput {
  return fields as unknown as MonitorCreateInput
}

function timerAt(clock: { now: Date }) {
  return defineSource(timerSource, { http, mcp, now: () => clock.now })
}

describe("timerSource", () => {
  test("build resolves the input against the host's clock", () => {
    const monitor = timerAt({ now: created })

    const source = monitor.build(input({ job: "check the deploy", in: "20m", timezone: "Asia/Kolkata" }))

    assert.deepEqual(source, { type: "timer", job: "check the deploy", due: "2026-11-19T15:20:00+05:30", timezone: "Asia/Kolkata" })
  })

  test("names a one-shot and an interval", () => {
    const monitor = timerAt({ now: created })
    const oneShot = monitor.build(input({ job: "check the deploy", in: "20m", timezone: "Asia/Kolkata" })) as TimerSource
    const interval = monitor.build(input({ job: "stretch", every: "45m", timezone: "Asia/Kolkata" })) as TimerSource

    assert.equal(monitor.key(oneShot), "timer:check the deploy:2026-11-19T15:20:00+05:30")
    assert.equal(monitor.key(interval), "timer:stretch:45m:2026-11-19T15:00:00+05:30")
    assert.equal(monitor.label(oneShot), "check the deploy")
    assert.equal(monitor.detail(oneShot), " at 2026-11-19T15:20:00+05:30 Asia/Kolkata")
    assert.equal(monitor.detail(interval), " every 45m Asia/Kolkata")
    assert.equal(monitor.describe(oneShot), "Timer check the deploy (at 2026-11-19T15:20:00+05:30)")
    assert.equal(monitor.describe(interval), "Timer stretch (every 45m)")
    assert.equal(monitor.defaultPollIntervalSec, 15)
  })
})

describe("a timer across a restart", () => {
  function runtime(store: MonitorStore, clock: { now: Date }, delivered: MonitorEvent[]): MonitorRuntime {
    const sink: MonitorEventSink = { deliver: async ({ event }) => { delivered.push(event); return { ok: true } } }
    return new MonitorRuntime({ store, sink, sources: { timer: timerAt(clock) }, sourceForWebhookPath: () => undefined })
  }

  // The tick reads the real clock for the poll interval, so the last poll is set far enough back to be due.
  async function due(daemon: MonitorRuntime): Promise<void> {
    for (const record of await daemon.service.list()) {
      await daemon.service.updateCursor(record, "__lastPolledAt", Date.now() - 16_000)
    }
  }

  test("a one-shot due while stopped fires once, late, and ends", async () => {
    const store = new InMemoryMonitorStore()
    const clock = { now: created }
    const delivered: MonitorEvent[] = []
    const first = runtime(store, clock, delivered)
    const source = timerAt(clock).build(input({ job: "check the deploy", in: "20m", timezone: "Asia/Kolkata" }))
    const { monitor } = await first.service.create({
      name: "deploy",
      source: source as TimerSource,
      delivery: "poll",
      target: { kind: "test", id: "session-1" },
      pollIntervalSec: 15,
    })

    await first.tick()
    assert.equal(delivered.length, 0)
    await first.stop()

    clock.now = new Date("2026-11-19T12:50:00Z")
    const second = runtime(store, clock, delivered)
    await due(second)
    await second.tick()

    assert.deepEqual(delivered.map((event) => [event.kind, event.subject?.late, event.subject?.lateSec]), [["timer.fired", true, 3 * 3600]])
    const ended = await second.service.get(monitor.id)
    assert.equal(ended?.enabled, false)
    assert.equal(typeof ended?.endedAt, "string")

    const third = runtime(store, clock, delivered)
    await due(third)
    await third.tick()

    assert.equal(delivered.length, 1)
  })
})
