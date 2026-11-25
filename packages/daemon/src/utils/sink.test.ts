import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InMemoryMonitorEventQueue,
  type MonitorEvent,
  type MonitorEventQueue,
  type MonitorRecord,
  type MonitorTarget,
} from "@sourcefed/core";
import {
  ChauffeurTriage,
  type Navigator,
  type TriageDecision,
  type TriageIntent,
} from "../triage/triage.ts";
import { NotifyingEventSink } from "./sink.ts";

const target: MonitorTarget = { kind: "test", id: "session-1" };

function monitorRecord(): MonitorRecord {
  return {
    id: "monitor-1",
    name: "test monitor",
    source: { type: "github", repo: "wrkhse/sourcefed", prNumber: 42 },
    delivery: "poll",
    target,
    pollIntervalSec: 60,
    enabled: true,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    cursors: {},
  };
}

function monitorEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    source: { type: "github" },
    kind: "review",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Changes requested on PR #42",
    actionable: true,
    ...overrides,
  };
}

/** A navigator that ignores the signal, so only the triage deadline can end the decision. */
function unresponsiveNavigator(): Navigator {
  return {
    navigate: () => new Promise<{ intents: readonly TriageIntent[] }>(() => {}),
    close: () => {},
  };
}

function sinkWith(decision?: TriageDecision, lines: string[] = []) {
  const queue = new InMemoryMonitorEventQueue();
  const notified: MonitorTarget[] = [];
  const triage = decision ? { decide: async () => decision } : undefined;
  const sink = new NotifyingEventSink(
    queue,
    (delivered) => notified.push(delivered),
    triage,
    (line) => lines.push(line),
  );

  return { queue, notified, sink };
}

/** A sink whose triage decide fails, either by throwing or by rejecting. */
function sinkWithFailingDecide(decide: () => Promise<TriageDecision>) {
  const queue = new InMemoryMonitorEventQueue();
  const notified: MonitorTarget[] = [];
  const sink = new NotifyingEventSink(
    queue,
    (delivered) => notified.push(delivered),
    { decide },
  );

  return { queue, notified, sink };
}

describe("NotifyingEventSink", () => {
  test("a withheld event is neither queued nor announced", async () => {
    const { queue, notified, sink } = sinkWith({
      deliver: false,
      rule: "sourcefed/triage",
    });

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );
    assert.deepEqual(await queue.read(target), []);
    assert.deepEqual(notified, []);
  });

  test("a withheld event logs one line naming the event, the monitor, the rule and the summary", async () => {
    const lines: string[] = [];
    const { queue, sink } = sinkWith(
      { deliver: false, rule: "sourcefed/triage" },
      lines,
    );

    assert.deepEqual(
      await sink.deliver({
        monitor: monitorRecord(),
        event: monitorEvent({ id: "review:1" }),
      }),
      { ok: true },
    );
    assert.deepEqual(lines, [
      "[sourcefed] withheld event=review:1 monitor=monitor-1 rule=sourcefed/triage: Changes requested on PR #42",
    ]);
    assert.deepEqual(await queue.read(target), []);
  });

  test("a withheld event whose intent names no rule logs rule=none", async () => {
    const lines: string[] = [];
    const { sink } = sinkWith({ deliver: false, rule: "" }, lines);

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );
    assert.deepEqual(lines, [
      "[sourcefed] withheld event=none monitor=monitor-1 rule=none: Changes requested on PR #42",
    ]);
  });

  test("a triaged event is queued and announced with the mark", async () => {
    const lines: string[] = [];
    const { queue, notified, sink } = sinkWith(
      { deliver: true, triaged: true },
      lines,
    );

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].chauffeurTriaged, true);
    assert.deepEqual(notified, [target]);
    assert.deepEqual(lines, []);
  });

  test("an untriaged event is queued without the mark", async () => {
    const { queue, notified, sink } = sinkWith({
      deliver: true,
      triaged: false,
    });

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(Object.hasOwn(queued[0], "chauffeurTriaged"), false);
    assert.deepEqual(notified, [target]);
  });

  test("without triage every event is queued unmarked", async () => {
    const { queue, notified, sink } = sinkWith();

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(Object.hasOwn(queued[0], "chauffeurTriaged"), false);
    assert.deepEqual(notified, [target]);
  });

  test("a triage that throws synchronously queues the event unmarked", async () => {
    const { queue, notified, sink } = sinkWithFailingDecide(() => {
      throw new Error("triage bug");
    });

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(Object.hasOwn(queued[0], "chauffeurTriaged"), false);
    assert.deepEqual(notified, [target]);
  });

  test("a triage that rejects queues the event unmarked", async () => {
    const { queue, notified, sink } = sinkWithFailingDecide(async () => {
      throw new Error("triage bug");
    });

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: true },
    );

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(Object.hasOwn(queued[0], "chauffeurTriaged"), false);
    assert.deepEqual(notified, [target]);
  });

  test("an enqueue failure is reported instead of thrown", async () => {
    const notified: MonitorTarget[] = [];
    const queue: MonitorEventQueue = {
      enqueue: async () => {
        throw new Error("disk full");
      },
      read: async () => [],
      acknowledge: async () => {},
    };
    const sink = new NotifyingEventSink(queue, (delivered) =>
      notified.push(delivered),
    );

    assert.deepEqual(
      await sink.deliver({ monitor: monitorRecord(), event: monitorEvent() }),
      { ok: false, error: "disk full" },
    );
    assert.deepEqual(notified, []);
  });

  test("a Chauffeur that never answers delivers untriaged before the deadline", async () => {
    const queue = new InMemoryMonitorEventQueue();
    const notified: MonitorTarget[] = [];
    const triage = new ChauffeurTriage({
      connect: () => unresponsiveNavigator(),
      // A fake endpoint, so discovery never probes a real Chauffeur socket.
      discover: async () => ({
        socket: "/run/user/501/chauffeur/daemon.sock",
        version: "1.2.3",
      }),
      deadlineMs: 100,
      log: () => {},
    });
    const sink = new NotifyingEventSink(
      queue,
      (delivered) => notified.push(delivered),
      triage,
    );

    const started = Date.now();
    const result = await sink.deliver({
      monitor: monitorRecord(),
      event: monitorEvent(),
    });
    const elapsed = Date.now() - started;

    assert.deepEqual(result, { ok: true });
    assert.ok(elapsed < 1_000, `deliver took ${elapsed}ms`);

    const queued = await queue.read(target);
    assert.equal(queued.length, 1);
    assert.equal(Object.hasOwn(queued[0], "chauffeurTriaged"), false);
    assert.deepEqual(notified, [target]);

    triage.close();
  });
});
