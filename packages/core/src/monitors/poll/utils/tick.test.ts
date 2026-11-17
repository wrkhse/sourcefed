import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, mock, test } from "node:test"
import type { MonitorContext } from "#sourcefed/types"
import { InMemoryMonitorStore } from "../../../storage/in-memory-monitor-store.ts"
import { MonitorService } from "../../service.ts"
import type { Monitor } from "../../monitor"
import type { MonitorRecord } from "../../types"
import { tick } from "./tick.ts"

type TestSource = { type: "test"; key: string }

// A source that advertises its identity and fails the poll the way a provider does.
function failingSource(run: () => Promise<never>): Monitor {
  return {
    validateSource: (source: TestSource) => source,
    key: (source: TestSource) => `test:${source.key}`,
    tick: run,
  } as unknown as Monitor
}

function context(service: MonitorService, source: Monitor): MonitorContext {
  return {
    service,
    sink: { deliver: async () => ({ ok: true }) },
    sources: { test: source },
    sourceForWebhookPath: () => undefined,
  }
}

async function createRecord(service: MonitorService): Promise<MonitorRecord> {
  const created = await service.create({
    name: "test",
    source: { type: "test", key: "issue-1" },
    delivery: "poll",
    target: { kind: "test", id: "session-1" },
    pollIntervalSec: 60,
  })
  return created.monitor
}

describe("poll failure logging", () => {
  let calls: unknown[][]

  beforeEach(() => {
    calls = []
    mock.method(console, "error", (...args: unknown[]) => { calls.push(args) })
  })

  afterEach(() => {
    delete process.env.SOURCEFED_DEBUG
    mock.restoreAll()
  })

  test("a failed poll logs exactly one line with the monitor id and the message", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new Error("GitHub has no pull request wrkhse/x#1") })

    await tick(context(service, source))

    assert.deepEqual(calls, [[
      `[sourcefed] monitor ${record.id} (test issue-1) poll failed: GitHub has no pull request wrkhse/x#1`,
    ]])
    assert.ok(!String(calls[0]![0]).includes("\n"), "one line, no stack")
    assert.equal((await service.get(record.id))?.cursors.__lastAttemptAt === undefined, false, "the attempt is stamped")
    assert.equal((await service.get(record.id))?.cursors.__lastPolledAt, undefined, "a failure is not a poll")
  })

  test("a failed poll timestamp update logs exactly one line too", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const record = await createRecord(service)
    service.updateCursor = async () => { throw new Error("store unavailable") }
    const source = failingSource(async () => { throw new Error("upstream unavailable") })

    await tick(context(service, source))

    assert.deepEqual(calls, [
      [`[sourcefed] monitor ${record.id} (test issue-1) poll failed: upstream unavailable`],
      [`[sourcefed] monitor ${record.id} (test issue-1) poll timestamp update failed: store unavailable`],
    ])
  })

  test("a thrown value that is not an Error keeps its value", async () => {
    const service = new MonitorService(new InMemoryMonitorStore())
    const record = await createRecord(service)
    const source = failingSource(async () => { throw "upstream stopped" })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], `[sourcefed] monitor ${record.id} (test issue-1) poll failed: upstream stopped`)
    assert.equal(calls[0]![1], "upstream stopped")
  })

  test("SOURCEFED_DEBUG keeps the stack", async () => {
    process.env.SOURCEFED_DEBUG = "1"
    const service = new MonitorService(new InMemoryMonitorStore())
    const record = await createRecord(service)
    const failure = new Error("boom")
    const source = failingSource(async () => { throw failure })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], `[sourcefed] monitor ${record.id} (test issue-1) poll failed: boom`)
    assert.equal(calls[0]![1], failure)
  })
})
