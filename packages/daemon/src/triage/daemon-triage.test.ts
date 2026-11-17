import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  InMemoryMonitorEventQueue,
  InMemoryMonitorStore,
  type MonitorEvent,
  type MonitorRecord,
  type MonitorTarget,
  type QueuedMonitorEvent,
} from "@sourcefed/core"
import { SourcefedDaemon } from "../daemon.ts"
import type { EventTriage } from "../types/daemon.ts"

const target: MonitorTarget = { kind: "test", id: "session-1" }

type Decision = Awaited<ReturnType<EventTriage["decide"]>>

function fakeTriage(decide: (monitor: MonitorRecord, event: MonitorEvent) => Promise<Decision>) {
  let closes = 0
  const triage: EventTriage = {
    decide,
    close() {
      closes += 1
    },
  }

  return { triage, closeCount: () => closes }
}

function createDaemon(triage?: EventTriage): SourcefedDaemon {
  return new SourcefedDaemon({
    store: new InMemoryMonitorStore(),
    eventQueue: new InMemoryMonitorEventQueue(),
    triage,
  })
}

async function jiraMonitor(daemon: SourcefedDaemon): Promise<MonitorRecord> {
  const created = await daemon.createMonitor(target, { name: "ADEPT-43742", sourceType: "jira", issueKey: "ADEPT-43742" })
  if (!created.ok || !created.monitor) throw new Error("monitor creation failed")

  const record = await daemon.service.get(created.monitor.id)
  if (!record) throw new Error("monitor record not found")

  return record
}

function commentEvent(): MonitorEvent {
  return {
    source: { type: "jira", issueKey: "ADEPT-43742" },
    kind: "comment",
    id: "comment:1",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Jira ADEPT-43742 comment",
    actionable: true,
  }
}

/** Lets the daemon's promise-chained delivery run before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("SourcefedDaemon triage", () => {
  test("a withheld event reaches neither the queue nor a subscriber", async () => {
    const fake = fakeTriage(async () => ({ deliver: false }))
    const daemon = createDaemon(fake.triage)
    const record = await jiraMonitor(daemon)

    const received: QueuedMonitorEvent[] = []
    const unsubscribe = daemon.subscribe(target, (events) => received.push(...events))

    const result = await daemon.runtime.context.sink.deliver({ monitor: record, event: commentEvent() })
    await settle()

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(await daemon.readEvents(target), [])
    assert.deepEqual(received, [])

    unsubscribe()
    await daemon.stop()
  })

  test("a triaged event is queued and delivered once with the mark", async () => {
    const fake = fakeTriage(async () => ({ deliver: true, triaged: true }))
    const daemon = createDaemon(fake.triage)
    const record = await jiraMonitor(daemon)

    const received: QueuedMonitorEvent[] = []
    const unsubscribe = daemon.subscribe(target, (events) => received.push(...events))

    await daemon.runtime.context.sink.deliver({ monitor: record, event: commentEvent() })
    await settle()

    const queued = await daemon.readEvents(target)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].chauffeurTriaged, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].id, queued[0].id)
    assert.equal(received[0].chauffeurTriaged, true)

    unsubscribe()
    await daemon.stop()
  })

  test("a stop that throws still closes triage and rejects with the same error", async () => {
    const fake = fakeTriage(async () => ({ deliver: true, triaged: false }))
    const daemon = createDaemon(fake.triage)
    const failure = new Error("runtime stop failed")

    // Stubbed runtime: a stop() that rejects proves triage still closes behind it.
    daemon.runtime.stop = async () => {
      throw failure
    }

    await assert.rejects(daemon.stop(), (error) => error === failure)
    assert.equal(fake.closeCount(), 1)
  })

  test("stop closes triage once per stop, and stopping again is harmless", async () => {
    const fake = fakeTriage(async () => ({ deliver: true, triaged: false }))
    const daemon = createDaemon(fake.triage)

    await daemon.stop()
    assert.equal(fake.closeCount(), 1)

    // close is idempotent, so a second stop needs no guard of its own.
    await daemon.stop()
    assert.equal(fake.closeCount(), 2)
  })
})
