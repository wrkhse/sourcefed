import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { describe, test } from "node:test"
import { InMemoryMonitorEventQueue, InMemoryMonitorStore, type MonitorEvent, type MonitorRecord, type MonitorTarget, type QueuedMonitorEvent } from "@sourcefed/core"
import { SourcefedDaemon } from "./daemon.ts"

const target: MonitorTarget = { kind: "test", id: "session-1" }
const SECRET = "terminal-delivery-secret"
const repo = "example-org/example-repo"
const prNumber = 7

// The golden fixture's merged delivery: pull request #7 closed and merged.
const mergedBody = JSON.stringify({
  action: "closed",
  pull_request: { number: prNumber, merged: true, title: "Add schedules" },
  repository: { full_name: repo },
})

function createDaemon(store = new InMemoryMonitorStore(), eventQueue = new InMemoryMonitorEventQueue()): SourcefedDaemon {
  return new SourcefedDaemon({ store, eventQueue })
}

function mergedDelivery(): Request {
  const signature = `sha256=${createHmac("sha256", SECRET).update(mergedBody).digest("hex")}`
  return new Request("http://daemon.test/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-merged",
      "x-hub-signature-256": signature,
    },
    body: mergedBody,
  })
}

/** Sets the webhook secret for the run and puts the previous value back. */
async function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET
  process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET = SECRET
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET
    else process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET = previous
  }
}

// The stores are in memory, so delivery is promise work only: one turn of the event
// loop runs it to the end.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function createPullRequestMonitor(daemon: SourcefedDaemon): Promise<string> {
  const created = await daemon.createMonitor(target, { name: "pr", sourceType: "github", repo, prNumber })
  if (!created.ok || !created.monitor) throw new Error("monitor creation failed")
  return created.monitor.id
}

async function mergeWhileNobodyListens(daemon: SourcefedDaemon): Promise<string> {
  const id = await createPullRequestMonitor(daemon)
  const response = await daemon.webhook(mergedDelivery())
  assert.equal(response.status, 200)
  return id
}

async function subscribeAndSettle(daemon: SourcefedDaemon): Promise<QueuedMonitorEvent[]> {
  const received: QueuedMonitorEvent[] = []
  daemon.subscribe(target, (events) => { received.push(...events) })
  await settle()
  return received
}

describe("terminal events", () => {
  test("a merged pull request's event reaches a session that subscribes after it", async () => {
    await withSecret(async () => {
      const daemon = createDaemon()
      await mergeWhileNobodyListens(daemon)

      const received = await subscribeAndSettle(daemon)

      assert.deepEqual(
        received.map((queued) => [queued.event.kind, queued.event.summary]),
        [["merged", `GitHub PR closed and merged on ${repo}#${prNumber}`]],
      )
      await daemon.stop()
    })
  })

  test("an ended monitor leaves the lists at once and the store once its event is acknowledged", async () => {
    await withSecret(async () => {
      const store = new InMemoryMonitorStore()
      const daemon = createDaemon(store)
      const id = await mergeWhileNobodyListens(daemon)

      assert.deepEqual(await daemon.listMonitors(target), { ok: true, monitors: [] })
      assert.equal((await daemon.getMonitor(target, id)).ok, true)

      const received = await subscribeAndSettle(daemon)
      await daemon.acknowledgeEvents(target, received.map((queued) => queued.id))

      assert.deepEqual(await daemon.listMonitors(target), { ok: true, monitors: [] })
      assert.deepEqual((await store.load()).monitors, [])
      await daemon.stop()
    })
  })

  test("a user's stop drops an ended monitor's queued event", async () => {
    await withSecret(async () => {
      const store = new InMemoryMonitorStore()
      const daemon = createDaemon(store)
      const id = await mergeWhileNobodyListens(daemon)

      assert.equal((await daemon.stopMonitor(target, id)).ok, true)
      const received = await subscribeAndSettle(daemon)

      assert.deepEqual(received, [])
      assert.deepEqual(await daemon.readEvents(target), [])
      assert.deepEqual((await store.load()).monitors, [])
      await daemon.stop()
    })
  })

  test("a host that restarts still finds the target of an ended monitor whose event waits", async () => {
    await withSecret(async () => {
      const daemon = createDaemon()
      await mergeWhileNobodyListens(daemon)

      assert.deepEqual(await daemon.listTargets("test"), [target])
      await daemon.stop()
    })
  })

  test("an ending heard after its last event was acknowledged removes the record at once", async () => {
    // With the secret set the monitor takes webhooks, so the start's first tick polls nothing.
    await withSecret(async () => {
      const store = new InMemoryMonitorStore()
      const daemon = createDaemon(store)
      await daemon.start()
      const id = await createPullRequestMonitor(daemon)
      const record = await daemon.service.get(id)
      if (!record) throw new Error("monitor record not found")

      // The source's last event is queued and taken before its poll gets to end the monitor.
      await daemon.runtime.context.sink.deliver({ monitor: record, event: mergedEvent(record.source) })
      const received = await subscribeAndSettle(daemon)
      await daemon.acknowledgeEvents(target, received.map((queued) => queued.id))
      await daemon.service.end(id)

      assert.deepEqual((await store.load()).monitors, [])
      await daemon.stop()
    })
  })

  test("stopping an ended monitor with nothing queued leaves no record", async () => {
    const store = new InMemoryMonitorStore({ monitors: [endedRecord("m-drained", 6)] })
    const daemon = createDaemon(store)

    assert.equal((await daemon.stopMonitor(target, "m-drained")).ok, true)

    assert.deepEqual((await store.load()).monitors, [])
    await daemon.stop()
  })

  test("starting removes ended monitors with nothing queued and keeps those with events waiting", async () => {
    const drained = endedRecord("m-drained", 6)
    const waiting = endedRecord("m-waiting", 7)
    const store = new InMemoryMonitorStore({ monitors: [drained, waiting] })
    const queue = new InMemoryMonitorEventQueue()
    await queue.enqueue({ monitor: waiting, event: mergedEvent(waiting.source) })
    const daemon = createDaemon(store, queue)

    await daemon.start()
    await daemon.stop()

    assert.deepEqual((await store.load()).monitors.map((monitor) => monitor.id), ["m-waiting"])
  })
})

function mergedEvent(source: MonitorRecord["source"]): MonitorEvent {
  return {
    source,
    kind: "merged",
    id: "pr:MERGED",
    at: "2026-11-18T12:09:00.000Z",
    summary: `GitHub PR closed and merged on ${repo}#${prNumber}`,
    actionable: true,
    terminal: true,
  }
}

function endedRecord(id: string, number: number): MonitorRecord {
  const at = "2026-11-18T12:09:00.000Z"
  return {
    id,
    name: "pr",
    source: { type: "github", repo, prNumber: number },
    delivery: "webhook",
    target,
    pollIntervalSec: 60,
    enabled: false,
    createdAt: at,
    updatedAt: at,
    cursors: {},
    endedAt: at,
  }
}
