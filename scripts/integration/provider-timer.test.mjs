import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDaemonClient } from "@sourcefed/daemon";
import {
  assert,
  assertEqual,
  freePort,
  removeDir,
  startHostDaemon,
  startProcess,
  tempDir,
  waitForReachable,
} from "./harness.mjs";

// Far past the provider's two-minute on-time window, so the first poll finds it late.
const PAST_MS = 3 * 60_000;
// Daemon A ticks once on start, before the monitor exists, and never again within the test.
const IDLE_LOOP_SEC = 3_600;
const EVENT_LIMIT_MS = 20_000;
// The CLI daemon's poll loop (MonitorRuntime's default), the "one more poll cycle".
const POLL_CYCLE_MS = 5_000;

const dir = await tempDir("sourcefed-it-timer-");
const target = { kind: "program", id: "it" };
const stops = [];
try {
  // Daemon A: its own process, over dir, with a poll loop that never comes round.
  const port = await freePort();
  const urlA = `http://127.0.0.1:${port}`;
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "timer-daemon.mjs",
  );
  const a = startProcess(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      SOURCEFED_STATE_DIR: dir,
      SOURCEFED_DAEMON_PORT: String(port),
      TIMER_IT_POLL_LOOP_SEC: String(IDLE_LOOP_SEC),
    },
  });
  stops.push(a.stop);
  await waitForReachable(urlA);

  const clientA = await connectDaemonClient({ name: "timer-it-a", url: urlA });
  stops.push(() => clientA.close());
  const due = new Date(Math.floor((Date.now() - PAST_MS) / 1_000) * 1_000);
  const at = due.toISOString().replace(".000Z", "+00:00");
  const created = await clientA.request("monitor.create", {
    target,
    name: "deploy",
    sourceType: "timer",
    job: "check the deploy",
    at,
    timezone: "UTC",
  });
  assert(created.ok, `create timer monitor: ${created.error}`);
  assertEqual(
    created.monitor.pollIntervalSec,
    15,
    "a timer checks every 15 seconds",
  );

  const listedA = await clientA.request("monitor.list", { target });
  assertEqual(
    listedA.monitors.some((monitor) => monitor.id === created.monitor.id),
    true,
    "A lists the one-shot",
  );
  assertEqual(
    (await clientA.request("monitor.events", { target })).events.length,
    0,
    "A never polled it, so nothing fired",
  );
  await clientA.close();
  await a.stop();

  // Daemon B: the packed CLI daemon, its own process, over the same dir, with its default loop.
  const b = await startHostDaemon({ SOURCEFED_STATE_DIR: dir });
  stops.push(b.stop);
  const clientB = await connectDaemonClient({ name: "timer-it-b", url: b.url });
  stops.push(() => clientB.close());

  const received = [];
  let first;
  let second;
  const firstEvent = new Promise((resolve) => {
    first = resolve;
  });
  const secondEvent = new Promise((resolve) => {
    second = resolve;
  });
  const subscription = await clientB.subscribe(
    target,
    async (events) => {
      received.push(...events);
      if (received.length >= 1) first();
      if (received.length >= 2) second();
    },
    { acknowledge: false },
  );
  stops.push(() => subscription.close());

  const arrived = await within(firstEvent, EVENT_LIMIT_MS);
  assert(arrived, `no event within ${EVENT_LIMIT_MS} ms`);
  assertEqual(
    received[0].event.kind,
    "timer.fired",
    "the one-shot fires after the restart",
  );
  assertEqual(
    received[0].event.subject.at,
    at,
    "it fires for the time it was due",
  );
  assertEqual(
    received[0].event.subject.late,
    true,
    "found past the on-time window, it is late",
  );

  // One more poll cycle brings nothing, and the saved queue holds the one event.
  assertEqual(
    await within(secondEvent, POLL_CYCLE_MS + 1_000),
    false,
    "a one-shot fires only once",
  );
  const queued = (await clientB.request("monitor.events", { target })).events;
  assertEqual(
    queued.map((entry) => entry.id).join(","),
    received[0].id,
    "the saved queue holds exactly the one firing",
  );

  const acknowledged = await clientB.request("monitor.ack", {
    target,
    eventIDs: [received[0].id],
  });
  assert(acknowledged.ok, `acknowledge: ${acknowledged.error}`);
  const listedB = await clientB.request("monitor.list", { target });
  assertEqual(
    listedB.monitors.some((monitor) => monitor.id === created.monitor.id),
    false,
    "the fired one-shot is no longer listed",
  );

  console.log(
    "provider-timer: a one-shot past due, created in one daemon process, fires once, late, in the next — ok",
  );
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  await removeDir(dir);
}

/** Whether `promise` settles within `ms`. */
async function within(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
