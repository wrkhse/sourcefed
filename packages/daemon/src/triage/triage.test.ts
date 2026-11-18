import assert from "node:assert/strict"
import { describe, mock, test, type TestContext } from "node:test"
import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import type { ChauffeurEndpoint } from "./discover.ts"
import { triageEvidence } from "./evidence.ts"
import {
  ChauffeurTriage,
  REPROBE_INTERVAL_MS,
  type Navigator,
  type TriageIntent,
  type TriageRequest,
} from "./triage.ts"

const endpoint: ChauffeurEndpoint = { socket: "/run/user/501/chauffeur/daemon.sock", version: "1.2.3" }

function monitorRecord(): MonitorRecord {
  return {
    id: "monitor-1",
    name: "test monitor",
    source: { type: "github", repo: "wrkhse/chauffeur", prNumber: 42 },
    delivery: "poll",
    target: { kind: "test", id: "session-1" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    cursors: {},
  }
}

function monitorEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    source: { type: "github" },
    kind: "review",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Changes requested on PR #42",
    actionable: true,
    ...overrides,
  }
}

type Reply = (request: TriageRequest, options: { signal: AbortSignal }) => Promise<unknown>

/** Fakes only setTimeout, so a test drives the deadline with tick instead of wall time. */
function mockTimers(t: TestContext): void {
  t.after(() => mock.timers.reset())
  mock.timers.enable({ apis: ["setTimeout"] })
}

/** A reply that never settles; `asked` resolves once the navigator has the request. */
function unansweredReply() {
  const asked = Promise.withResolvers<void>()
  return {
    asked: asked.promise,
    reply: () => {
      asked.resolve()
      return new Promise(() => {})
    },
  }
}

function fakeNavigator(reply: Reply = async () => ({ intents: [] })) {
  const requests: TriageRequest[] = []
  const signals: AbortSignal[] = []
  let closes = 0

  const navigator: Navigator = {
    navigate(request, options) {
      requests.push(request)
      signals.push(options.signal)
      return reply(request, options) as Promise<{ intents: readonly TriageIntent[] }>
    },
    close() {
      closes += 1
    },
  }

  return { navigator, requests, signals, closeCount: () => closes }
}

type FakeNavigator = ReturnType<typeof fakeNavigator>

type HarnessOptions = {
  endpoints?: Array<ChauffeurEndpoint | undefined>
  reply?: Reply
  deadlineMs?: number
  log?: (line: string) => void
  probe?: () => Promise<void>
}

function harness(options: HarnessOptions = {}) {
  const clock = { now: 0 }
  const endpoints = options.endpoints ?? [endpoint]
  const logs: string[] = []
  const connections: FakeNavigator[] = []
  const connected = Promise.withResolvers<void>()
  let discovers = 0
  let connects = 0

  const triage = new ChauffeurTriage({
    connect: () => {
      connects += 1
      const fake = fakeNavigator(options.reply)
      connections.push(fake)
      connected.resolve()
      return fake.navigator
    },
    discover: async () => {
      const probeIndex = Math.min(discovers, endpoints.length - 1)
      discovers += 1
      await options.probe?.()
      return endpoints[probeIndex]
    },
    now: () => clock.now,
    deadlineMs: options.deadlineMs ?? 500,
    log: options.log ?? ((line) => logs.push(line)),
  })

  return {
    triage,
    clock,
    logs,
    connections,
    connected: connected.promise,
    discovers: () => discovers,
    connects: () => connects,
  }
}

const monitor = monitorRecord()
const event = monitorEvent()

describe("ChauffeurTriage", () => {
  test("a withhold intent withholds the event and the request carries its evidence", async () => {
    const h = harness({ reply: async () => ({ intents: [{ rule: "sourcefed/triage", withhold: "event" }] }) })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: false, rule: "sourcefed/triage" })
    assert.deepEqual(h.logs, [
      `[sourcefed] Chauffeur v2 ${endpoint.version} at ${endpoint.socket}: events are triaged before delivery`,
    ])

    const request = h.connections[0].requests[0]
    assert.equal(request.on, "sourcefed.event")
    assert.equal(request.deadline_ms, 500)
    assert.deepEqual(request.evidence, triageEvidence(monitor, event))
  })

  test("no intent and an unrelated intent both deliver triaged", async () => {
    const empty = harness({ reply: async () => ({ intents: [] }) })
    assert.deepEqual(await empty.triage.decide(monitor, event), { deliver: true, triaged: true })

    const unrelated = harness({
      reply: async () => ({ intents: [{ rule: "sourcefed/quiet-hours", withhold: "notification" }] }),
    })
    assert.deepEqual(await unrelated.triage.decide(monitor, event), { deliver: true, triaged: true })
  })

  test("a malformed result delivers untriaged", async () => {
    for (const result of [undefined, { intents: "x" }]) {
      const h = harness({ reply: async () => result })

      assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    }
  })

  test("an absent Chauffeur is only probed again after the interval", async () => {
    const h = harness({ endpoints: [undefined, endpoint] })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 0)

    h.clock.now = 10_000
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 0)

    h.clock.now = REPROBE_INTERVAL_MS
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: true })
    assert.equal(h.discovers(), 2)
    assert.equal(h.connects(), 1)
  })

  test("a probe that outlives the deadline still connects for the next decide", async () => {
    const h = harness({
      deadlineMs: 50,
      probe: () => new Promise((resolve) => setTimeout(resolve, 100)),
    })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    await h.connected
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 1)

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: true })
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 1)
  })

  test("concurrent decides share one probe and one connection", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness({ probe: () => gate.promise })

    const decisions = Promise.all([
      h.triage.decide(monitor, event),
      h.triage.decide(monitor, event),
      h.triage.decide(monitor, event),
    ])
    gate.resolve()

    assert.deepEqual(await decisions, [
      { deliver: true, triaged: true },
      { deliver: true, triaged: true },
      { deliver: true, triaged: true },
    ])
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 1)
  })

  test("an unavailable Chauffeur is reconnected and each loss is reported", async () => {
    const h = harness({ reply: async () => { throw { reason: "unavailable" } } })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.connections[0].closeCount(), 1)

    h.clock.now = REPROBE_INTERVAL_MS
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.discovers(), 2)
    assert.equal(h.connects(), 2)
    assert.equal(h.connections[1].closeCount(), 1)
    assert.equal(h.logs.filter((line) => line.includes("went away")).length, 2)
  })

  test("two concurrent failures of one navigator report one loss", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness({
      probe: () => gate.promise,
      reply: async () => { throw { reason: "unavailable" } },
    })

    const decisions = Promise.all([h.triage.decide(monitor, event), h.triage.decide(monitor, event)])
    gate.resolve()

    assert.deepEqual(await decisions, [
      { deliver: true, triaged: false },
      { deliver: true, triaged: false },
    ])
    assert.equal(h.connects(), 1)
    assert.equal(h.connections[0].closeCount(), 1)
    assert.equal(h.logs.filter((line) => line.includes("went away")).length, 1)
  })

  test("a busy Chauffeur is kept for the next event", async () => {
    const h = harness({ reply: async () => { throw { reason: "busy" } } })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.discovers(), 1)
    assert.equal(h.connects(), 1)
    assert.equal(h.connections[0].closeCount(), 0)
  })

  test("a navigator that ignores its signal still returns by the deadline", async (t) => {
    mockTimers(t)

    const unanswered = unansweredReply()
    const h = harness({ deadlineMs: 50, reply: unanswered.reply })

    const decision = h.triage.decide(monitor, event)
    await unanswered.asked
    mock.timers.tick(50)

    assert.equal(h.connections[0].signals[0].aborted, true)
    assert.deepEqual(await decision, { deliver: true, triaged: false })
  })

  test("close releases the navigator and stops probing", async () => {
    const h = harness()
    await h.triage.decide(monitor, event)

    h.triage.close()
    assert.equal(h.connections[0].closeCount(), 1)

    h.clock.now = REPROBE_INTERVAL_MS * 2
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: false })
    assert.equal(h.discovers(), 1)

    h.triage.close()
    assert.equal(h.connections[0].closeCount(), 1)
  })

  test("close settles a decide still waiting on a navigator and aborts its signal", async (t) => {
    mockTimers(t)

    const unanswered = unansweredReply()
    const h = harness({ deadlineMs: 10_000, reply: unanswered.reply })

    const decision = h.triage.decide(monitor, event)
    await unanswered.asked
    h.triage.close()

    assert.equal(h.connections[0].signals[0].aborted, true)
    assert.deepEqual(await decision, { deliver: true, triaged: false })
  })

  test("a settled decide leaves no deadline timer behind", async (t) => {
    mockTimers(t)
    const h = harness({ deadlineMs: 10_000 })

    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: true })

    // An uncleared deadline would abort the signal the navigator holds once the clock reaches it.
    mock.timers.tick(10_000)
    assert.equal(h.connections[0].signals[0].aborted, false)
    assert.equal(h.logs.filter((line) => line.includes("went away")).length, 0)
  })

  test("a silent navigator is dropped at the deadline so the rest of a batch is immediate", async (t) => {
    mockTimers(t)

    const unanswered = unansweredReply()
    const h = harness({ deadlineMs: 100, reply: unanswered.reply })

    const first = h.triage.decide(monitor, event)
    await unanswered.asked
    mock.timers.tick(100)

    assert.equal(h.connections[0].signals[0].aborted, true)
    assert.deepEqual(await first, { deliver: true, triaged: false })

    // The rest settle with the mock clock still, so no deadline elapses for them.
    const rest = [await h.triage.decide(monitor, event), await h.triage.decide(monitor, event)]
    assert.deepEqual(rest, [
      { deliver: true, triaged: false },
      { deliver: true, triaged: false },
    ])
    assert.equal(h.connects(), 1)
    assert.equal(h.connections[0].closeCount(), 1)
    assert.equal(h.logs.filter((line) => line.includes("went away")).length, 1)
  })

  test("after the reprobe interval a dropped navigator is probed and connected again", async (t) => {
    mockTimers(t)

    const asked = Promise.withResolvers<void>()
    let calls = 0
    const h = harness({
      deadlineMs: 100,
      reply: () => {
        if (calls++ > 0) return Promise.resolve({ intents: [] })
        asked.resolve()
        return new Promise(() => {})
      },
    })

    const first = h.triage.decide(monitor, event)
    await asked.promise
    mock.timers.tick(100)

    assert.equal(h.connections[0].signals[0].aborted, true)
    assert.deepEqual(await first, { deliver: true, triaged: false })
    assert.equal(h.connects(), 1)

    h.clock.now = REPROBE_INTERVAL_MS
    assert.deepEqual(await h.triage.decide(monitor, event), { deliver: true, triaged: true })
    assert.equal(h.discovers(), 2)
    assert.equal(h.connects(), 2)
  })
})
