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
function failingSource(run: () => Promise<never>, label = "example.test"): Monitor {
  return {
    validateSource: (source: TestSource) => source,
    key: (source: TestSource) => `test:https://user:secret@example.test/feed?token=secret-${source.key}`,
    label: () => label,
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
    const storeFailure = new Error("store unavailable")
    service.updateCursor = async () => { throw storeFailure }
    const source = failingSource(async () => { throw new PollSourceError("upstream unavailable") })

    await tick(context(service, source))

    assert.deepEqual(calls[0], [
      `[sourcefed] monitor ${record.id} (test example.test) poll failed: upstream unavailable`,
    ])
    assert.equal(calls.length, 2)
    assert.equal(calls[1]![0], `[sourcefed] monitor ${record.id} (test example.test) poll timestamp update failed: store unavailable`)
    assert.equal(calls[1]!.length, 2, "a store failure is a bug, so the error comes too")
    assert.equal(calls[1]![1], storeFailure)
  })

  test("a message with a newline still logs one line", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("a\nb") })

    await tick(context(service, source))

    assert.deepEqual(calls, [[`[sourcefed] monitor ${record.id} (test example.test) poll failed: a b`]])
  })

  test("a message over the line's limit is cut with an ellipsis", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("x".repeat(301)) })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    const line = String(calls[0]![0])
    assert.ok(line.length <= 300, `the line is at most 300 characters, not ${line.length}`)
    assert.ok(line.endsWith("…"), "a cut line ends with an ellipsis")
    const prefix = `[sourcefed] monitor ${record.id} (test example.test) poll failed: `
    assert.equal(line.slice(prefix.length).length, 200, "the message is cut to 200 characters")
  })

  test("a cause that pushes the line past 300 is cut too", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("x".repeat(200), { cause: new Error("y".repeat(200)) }) })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    const line = String(calls[0]![0])
    assert.ok(line.length <= 300, `the line is at most 300 characters, not ${line.length}`)
    assert.ok(line.endsWith("…"), "a cut line ends with an ellipsis")
    assert.ok(line.includes("(cause: "), "the cause is still named")
  })

  test("a network failure's inner reason is on the line", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => {
      throw new PollSourceError("fetch failed", {
        cause: new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND feeds.example.test") }),
      })
    })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.ok(String(calls[0]![0]).endsWith("(cause: getaddrinfo ENOTFOUND feeds.example.test)"))
  })

  test("the cause walk stops at its depth bound", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => {
      let chain = new Error("level6")
      for (let level = 5; level >= 1; level -= 1) chain = new Error(`level${level}`, { cause: chain })
      throw new PollSourceError("outer", { cause: chain })
    })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    const line = String(calls[0]![0])
    assert.ok(line.includes("level4"), "the last cause within the bound is named")
    assert.ok(!line.includes("level5"), "the walk stops at the bound")
    assert.ok(!line.includes("level6"), "the walk stops at the bound")
  })

  test("an aggregate cause with no message still names its code", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => {
      const refused = new AggregateError([], "") as AggregateError & { code: string }
      refused.code = "ECONNREFUSED"
      throw new PollSourceError("fetch failed", { cause: new TypeError("fetch failed", { cause: refused }) })
    })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    assert.ok(String(calls[0]![0]).endsWith("(cause: ECONNREFUSED)"))
  })

  test("a source label over the identity's limit is cut with an ellipsis", async () => {
    const service = await serviceWithRecord()
    await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("boom") }, "l".repeat(81))

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    const line = String(calls[0]![0])
    assert.ok(line.length <= 300, `the line is at most 300 characters, not ${line.length}`)
    assert.ok(line.includes(`(test ${"l".repeat(79)}…)`), "the identity is cut to 80 characters with an ellipsis")
  })

  test("line separators and a next-line character collapse to spaces", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new PollSourceError("a\u2028b\u2029c\u0085d") })

    await tick(context(service, source))

    assert.equal(calls.length, 1)
    const line = String(calls[0]![0])
    assert.equal(line, `[sourcefed] monitor ${record.id} (test example.test) poll failed: a b c d`)
    assert.ok(!/[\u2028\u2029\u0085]/.test(line), "no line separator survives")
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

  test("a missing provider says so in one line", async () => {
    const service = await serviceWithRecord()
    const record = await createRecord(service)
    const source = failingSource(async () => { throw new Error("never called") })

    await tick({ ...context(service, source), sources: {} })

    assert.deepEqual(calls, [[`[sourcefed] monitor ${record.id}: no monitor provider for source type test`]])
  })
})
