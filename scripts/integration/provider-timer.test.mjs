import { assert, assertEqual, daemonEntry, removeDir, sleep, tempDir } from "./harness.mjs"

process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET = ""
process.env.SOURCEFED_SLACK_SIGNING_SECRET = ""
const { SourcefedDaemon } = await import(daemonEntry())

const WAIT_LIMIT_MS = 20_000
const RETRY_MS = 250
// Far past the provider's two-minute on-time window, so the first poll finds it late.
const PAST_MS = 3 * 60_000
// Daemon A ticks once on start and never again within the test.
const IDLE_LOOP_SEC = 3_600

const dir = await tempDir("sourcefed-it-timer-")
const target = { kind: "program", id: "it" }
let daemon = new SourcefedDaemon({ stateDir: dir, pollLoopSec: IDLE_LOOP_SEC })
try {
  // Created after start, so A's one tick at start never sees it.
  await daemon.start()

  const due = new Date(Math.floor((Date.now() - PAST_MS) / 1_000) * 1_000)
  const at = due.toISOString().replace(".000Z", "+00:00")
  const created = await daemon.createMonitor(target, { name: "deploy", sourceType: "timer", job: "check the deploy", at, timezone: "UTC" })
  assert(created.ok, `create timer monitor: ${created.error}`)
  assertEqual(created.monitor.pollIntervalSec, 15, "a timer checks every 15 seconds")

  assertEqual(await isListed(created.monitor.id), true, "the one-shot is listed before any poll")
  assertEqual((await daemon.readEvents(target)).length, 0, "nothing fires before a poll")
  await daemon.stop()

  // Daemon B over the same state, with the default loop, finds the time already past.
  daemon = new SourcefedDaemon({ stateDir: dir })
  await daemon.start()
  const received = []
  daemon.subscribe(target, async (events) => { received.push(...events) })

  await until(() => received.length > 0, async () => { await daemon.runtime.tick() })

  assertEqual(received.map((entry) => entry.event.kind).join(","), "timer.fired", "the one-shot fires once after the restart")
  assertEqual(received[0].event.subject.at, at, "it fires for the time it was due")
  assertEqual(received[0].event.subject.late, true, "found past the on-time window, it is late")

  // One more poll cycle brings nothing.
  await daemon.runtime.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assertEqual(received.length, 1, "a one-shot fires only once")

  const acknowledged = await daemon.acknowledgeEvents(target, [received[0].id])
  assert(acknowledged.ok, `acknowledge: ${acknowledged.error}`)
  await until(async () => !(await isListed(created.monitor.id)))

  await daemon.stop()
  console.log("provider-timer: a one-shot past due across a restart fires once, late, then ends — ok")
} finally {
  await daemon.stop().catch(() => {})
  await removeDir(dir)
}

async function isListed(id) {
  const listed = await daemon.listMonitors(target)
  assert(listed.ok, `list monitors: ${listed.error}`)
  return listed.monitors.some((monitor) => monitor.id === id)
}

/** Retries `step` until `done` holds, failing after WAIT_LIMIT_MS. */
async function until(done, step = async () => {}) {
  const deadline = Date.now() + WAIT_LIMIT_MS

  while (!(await done())) {
    assert(Date.now() < deadline, `condition not met within ${WAIT_LIMIT_MS} ms`)
    await step()
    await sleep(RETRY_MS)
  }
}
