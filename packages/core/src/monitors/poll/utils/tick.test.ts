import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, mock, test } from "node:test"
import type { MonitorContext } from "#sourcefed/types"
import { InMemoryMonitorStore } from "../../../storage/in-memory-monitor-store.ts"
import { MonitorService } from "../../service.ts"
import type { Monitor } from "../../monitor"
import type { MonitorRecord } from "../../types"
import { PollSourceError } from "../types/poll-source-error.ts"
import { tick } from "./tick.ts"

type TestSource = { type: "test"; key: string }

// A source that names itself and fails the poll the way a provider does. Its key is a cursor
// key holding a credential: a log line must never print it.
function failingSource(run: () => Promise<never>): Monitor {
  return {
    validateSource: (source: TestSource) => source,
    key: (source: TestSource) => `test:https://user:secret@example.test/feed?token=secret-${source.key}`,
    label: () => "example.test",
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

function serviceWithRecord(): Promise<MonitorService> {
  return Promise.resolve(new MonitorService(new InMemoryMonitorStore()))
}

describe("poll failure logging", () => {
  let calls: unknown[][]
  let previousDebug: string | undefined

  beforeEach(() => {
    previousDebug = process.env.SOURCEFED_DEBUG
    delete process.env.SOURCEFED_DEBUG
    calls = []
    mock.method(console, "error", (...args: unknown[]) => { calls.push(args) })
  })

  afterEach(() => {
    if (previousDebug === undefined) delete process.env.SOURCEFED_DEBUG
    else process.env.SOURCEFED_DEBUG = previousDebug
    mock.restoreAll()
  })

  test("a failed poll logs exactly one line with the monitor id and the message", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("GitHub has no pull request wrkhse/x#1") })

    await tick(context(service, source))

    assert.deepEqual(calls, [[
      `[sourcefed] monitor ${record.id} (test example.test) poll failed: GitHub has no pull request wrkhse/x#1`,
    ]])
    assert.equal((await service.get(record.id))?.cursors.__lastAttemptAt === undefined, false, "the attempt is stamped")
    assert.equal((await service.get(record.id))?.cursors.__lastPolledAt, undefined, "a failure is not a poll")
  })

  test("a failed poll timestamp update logs exactly one line too", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    service.updateCursor = async () => { throw new PollSourceError("store unavailable") }
    const source = failingSource(async () => { throw new PollSourceError("upstream unavailable") })

    await tick(context(service, source))

    assert.deepEqual(calls, [
      [`[sourcefed] monitor ${record.id} (test example.test) poll failed: upstream unavailable`],
      [`[sourcefed] monitor ${record.id} (test example.test) poll timestamp update failed: store unavailable`],
    ])
  })

  test("a message with a newline still logs one line", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("a\nb") })

    await tick(context(service, source))

    assert.deepEqual(calls, [[`[sourcefed] monitor ${record.id} (test example.test) poll failed: a b`]])
  })

  test("a thrown value that is not an Error keeps its value", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw "upstream stopped" })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], `[sourcefed] monitor ${record.id} (test example.test) poll failed: upstream stopped`)
    assert.equal(calls[0]![1], "upstream stopped")
  })

  test("a bug keeps its stack", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new TypeError("x is not a function") })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], `[sourcefed] monitor ${record.id} (test example.test) poll failed: x is not a function`)
    assert.ok(calls[0]![1] instanceof TypeError, "the error, and so its stack, is logged")
  })

  test("SOURCEFED_DEBUG keeps the stack of an expected failure", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const failure = new PollSourceError("boom")
    const source = failingSource(async () => { throw failure })

    process.env.SOURCEFED_DEBUG = "1"
    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], `[sourcefed] monitor ${record.id} (test example.test) poll failed: boom`)
    assert.equal(calls[0]![1], failure)
  })

  test("a source's cursor key never reaches the log", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("upstream unavailable") })

    await tick(context(service, source))

    const logged = calls.flat().map((entry) => String(entry)).join(" ")
    assert.ok(!logged.includes("secret"), "no credential from the key is logged")
  })
})
