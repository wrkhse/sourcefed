import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  InMemoryMonitorEventQueue,
  InMemoryMonitorStore,
  Monitor,
  MonitorRuntime,
  PollMonitor,
  WebhookMonitor,
  type MonitorEvent,
  type MonitorEventQueue,
  type MonitorRecord,
  type MonitorSchema,
  type MonitorTarget,
  type QueuedMonitorEvent,
  type SourcePollResult,
} from "@sourcefed/core"
import type { EventTriage } from "../types/daemon.ts"
import { NotifyingEventSink } from "../utils/sink.ts"

const target: MonitorTarget = { kind: "test", id: "session-1" }

type TestSource = { type: "test"; key: string }
type Poll = (source: TestSource, cursor: unknown) => Promise<SourcePollResult>
type Decision = Awaited<ReturnType<EventTriage["decide"]>>

/**
 * A fake source that polls from the cursor it is given, like a real one.
 * validateSource is overridden because the base schema belongs to a provider
 * this test does not load; the fake's own source shape is all it accepts.
 */
class TestMonitor extends Monitor<TestSource> {
  readonly key = (source: TestSource): string => source.key
  readonly input = { description: "A test source", properties: {}, required: [] }
  readonly icon = "?"
  readonly label = (source: TestSource): string => source.key
  readonly detail = (): string => ""
  readonly describe = (source: TestSource): string => `Test ${source.key}`
  readonly poll: PollMonitor<TestSource> | undefined = undefined
  readonly webhook: WebhookMonitor<TestSource> | undefined = undefined

  constructor(options: { poll?: Poll; webhook?: WebhookMonitor<TestSource> }) {
    // The base schema is never read: validateSource below accepts the fake's source.
    super({ type: "test", schema: {} as MonitorSchema<TestSource> })
    if (options.poll) this.poll = new PollMonitor({ run: options.poll })
    this.webhook = options.webhook
  }

  validateSource(source: unknown): TestSource {
    return source as TestSource
  }

  build(): TestSource {
    return { type: "test", key: "test" }
  }
}

function commentEvent(id: string): MonitorEvent {
  return {
    source: { type: "test", key: "issue-1" },
    kind: "comment",
    id,
    at: "2026-11-17T00:00:00.000Z",
    summary: `Test comment ${id}`,
    actionable: true,
  }
}

/** Records the event id of every decide, and answers per event id. */
function countingTriage(decisions: Record<string, Decision>) {
  const asked: string[] = []
  const decide = async (_monitor: MonitorRecord, event: MonitorEvent): Promise<Decision> => {
    const id = event.id ?? ""
    asked.push(id)
    return decisions[id] ?? { deliver: true, triaged: false }
  }

  return { decide, asked }
}

/** An in-memory queue whose enqueue fails once for one event id. */
class FailingOnceQueue implements MonitorEventQueue {
  private failuresLeft = 1

  constructor(private readonly inner: MonitorEventQueue, private readonly eventID: string) {}

  async enqueue(input: { monitor: MonitorRecord; event: MonitorEvent; chauffeurTriaged?: boolean }): Promise<QueuedMonitorEvent> {
    if (input.event.id === this.eventID && this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error("queue unavailable")
    }
    return this.inner.enqueue(input)
  }

  async read(target: MonitorTarget): Promise<QueuedMonitorEvent[]> {
    return this.inner.read(target)
  }

  async acknowledge(target: MonitorTarget, eventIDs: string[]): Promise<void> {
    return this.inner.acknowledge(target, eventIDs)
  }
}

async function createRuntime(options: {
  source: TestMonitor
  queue: MonitorEventQueue
  triage: Pick<EventTriage, "decide">
  delivery?: "poll" | "webhook"
}): Promise<{ runtime: MonitorRuntime; record: MonitorRecord }> {
  const runtime = new MonitorRuntime({
    store: new InMemoryMonitorStore(),
    sink: new NotifyingEventSink(options.queue, () => {}, options.triage),
    sources: { test: options.source },
    sourceForWebhookPath: (path) => (
      options.source.webhook?.path === path ? options.source as unknown as Monitor : undefined
    ),
  })
  const created = await runtime.service.create({
    name: "test",
    source: { type: "test", key: "issue-1" },
    delivery: options.delivery ?? "poll",
    target,
    pollIntervalSec: 60,
  })

  return { runtime, record: created.monitor }
}

describe("triage at the runtime transport", () => {
  test("a withheld event is not asked again once the source cursor has advanced", async () => {
    const event = commentEvent("event-1")
    let polls = 0
    const source = new TestMonitor({
      poll: async (_source, cursor) => {
        polls += 1
        return cursor === undefined
          ? { cursor: { seen: true }, events: [event], terminal: false }
          : { cursor, events: [], terminal: false }
      },
    })
    const queue = new InMemoryMonitorEventQueue()
    const triage = countingTriage({ "event-1": { deliver: false, rule: "sourcefed/triage" } })
    const { runtime, record } = await createRuntime({ source, queue, triage })

    try {
      await runtime.tick()

      const polled = await runtime.service.get(record.id)
      assert.deepEqual(polled?.cursors["issue-1"], { seen: true })
      assert.deepEqual(await queue.read(target), [])

      // The interval elapsed without waiting a minute; the second poll sees the stored cursor.
      await runtime.service.updateCursor(record, "__lastPolledAt", Date.now() - 61_000)
      await runtime.tick()

      assert.equal(polls, 2)
      assert.deepEqual(triage.asked, ["event-1"])
      assert.deepEqual(await queue.read(target), [])
    } finally {
      await runtime.stop()
    }
  })

  test("a failed enqueue retries the poll without asking an already-routed event again", async () => {
    const withheld = commentEvent("event-a")
    const delivered = commentEvent("event-b")
    let polls = 0
    const source = new TestMonitor({
      poll: async () => {
        polls += 1
        return { cursor: { seen: true }, events: [withheld, delivered], terminal: false }
      },
    })
    const inner = new InMemoryMonitorEventQueue()
    const queue = new FailingOnceQueue(inner, "event-b")
    const triage = countingTriage({
      "event-a": { deliver: false, rule: "sourcefed/triage" },
      "event-b": { deliver: true, triaged: true },
    })
    const { runtime, record } = await createRuntime({ source, queue, triage })

    try {
      await runtime.tick()

      const failed = await runtime.service.get(record.id)
      assert.deepEqual(failed?.cursors.__routedEventIds, ["event-a"])
      assert.equal(failed?.cursors["issue-1"], undefined, "a failed route must not advance the source cursor")

      await runtime.tick()

      assert.equal(polls, 2)
      assert.equal(triage.asked.filter((id) => id === "event-a").length, 1, "event A must be asked exactly once")
      // A failed enqueue re-offers the event to the sink, so triage judges it again.
      assert.equal(triage.asked.filter((id) => id === "event-b").length, 2)
      const queued = await inner.read(target)
      assert.equal(queued.length, 1)
      assert.equal(queued[0].event.id, "event-b")
      assert.equal(queued[0].chauffeurTriaged, true)

      const retried = await runtime.service.get(record.id)
      assert.deepEqual(retried?.cursors["issue-1"], { seen: true })
      assert.deepEqual(retried?.cursors.__routedEventIds, [])
    } finally {
      await runtime.stop()
    }
  })

  test("a withheld webhook event is not queued and the webhook answers success", async () => {
    const event = commentEvent("event-1")
    const webhook = new WebhookMonitor<TestSource>({
      path: "/webhooks/test",
      configured: () => true,
      verify: () => true,
      deliveryId: () => "delivery-1",
      eventName: () => "test",
      parse: () => event,
    })
    const source = new TestMonitor({ webhook })
    const queue = new InMemoryMonitorEventQueue()
    const triage = countingTriage({ "event-1": { deliver: false, rule: "sourcefed/triage" } })
    const { runtime, record } = await createRuntime({ source, queue, triage, delivery: "webhook" })

    try {
      const response = await runtime.webhook(new Request("http://daemon.test/webhooks/test", {
        method: "POST",
        body: JSON.stringify({}),
      }))

      assert.equal(response.status, 200)
      assert.equal(await response.text(), "ok")
      assert.deepEqual(await queue.read(target), [])
      assert.deepEqual(triage.asked, ["event-1"])

      const current = await runtime.service.get(record.id)
      assert.equal(current?.cursors["webhook:delivery-1"], true)
    } finally {
      await runtime.stop()
    }
  })
})
