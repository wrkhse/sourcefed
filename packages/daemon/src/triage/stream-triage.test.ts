import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InMemoryMonitorEventQueue,
  InMemoryMonitorStore,
  type MonitorEvent,
  type MonitorRecord,
  type MonitorTarget,
  type QueuedMonitorEvent,
} from "@sourcefed/core";
import { connectDaemonClient } from "../client.ts";
import { SourcefedDaemon } from "../daemon.ts";
import { handleDaemonHttpRequest } from "../http.ts";
import type { EventTriage } from "../types/daemon.ts";
import { serveHttp } from "../utils/http-server.ts";

const target: MonitorTarget = { kind: "test", id: "session-1" };

type Decision = Awaited<ReturnType<EventTriage["decide"]>>;

function fakeTriage(
  decide: (monitor: MonitorRecord, event: MonitorEvent) => Promise<Decision>,
): EventTriage {
  return { decide, close: () => {} };
}

/** Triages every event, marking the one whose id is "triaged". */
function createDaemon(): SourcefedDaemon {
  return new SourcefedDaemon({
    store: new InMemoryMonitorStore(),
    eventQueue: new InMemoryMonitorEventQueue(),
    triage: fakeTriage(async (_monitor, event) => ({
      deliver: true,
      triaged: event.id === "triaged",
    })),
  });
}

async function jiraMonitor(daemon: SourcefedDaemon): Promise<MonitorRecord> {
  const created = await daemon.createMonitor(target, {
    name: "ADEPT-43742",
    sourceType: "jira",
    issueKey: "ADEPT-43742",
  });
  if (!created.ok || !created.monitor)
    throw new Error("monitor creation failed");

  const record = await daemon.service.get(created.monitor.id);
  if (!record) throw new Error("monitor record not found");

  return record;
}

function commentEvent(id: string, monitor: MonitorRecord): MonitorEvent {
  return {
    source: monitor.source,
    kind: "comment",
    id,
    at: "2026-11-17T00:00:00.000Z",
    summary: `Test comment ${id}`,
    actionable: true,
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition did not become true");
}

function eventsByID(
  events: QueuedMonitorEvent[],
): Map<string, QueuedMonitorEvent> {
  return new Map(events.map((event) => [event.event.id ?? "", event]));
}

describe("the triage mark on daemon subscriptions", () => {
  test("a subscriber and the queue record the same event id and the same mark", async () => {
    const daemon = createDaemon();
    const record = await jiraMonitor(daemon);
    const received: QueuedMonitorEvent[] = [];
    const unsubscribe = daemon.subscribe(target, (events) =>
      received.push(...events),
    );

    try {
      await daemon.runtime.context.sink.deliver({
        monitor: record,
        event: commentEvent("triaged", record),
      });
      await daemon.runtime.context.sink.deliver({
        monitor: record,
        event: commentEvent("untriaged", record),
      });
      await until(() => received.length === 2);

      const delivered = eventsByID(received);
      const queued = eventsByID(await daemon.readEvents(target));
      assert.equal(queued.size, 2);

      for (const id of ["triaged", "untriaged"]) {
        const live = delivered.get(id);
        const stored = queued.get(id);
        assert.ok(live, `the subscriber did not receive ${id}`);
        assert.ok(stored, `the queue did not hold ${id}`);
        assert.equal(live.id, stored.id);
        assert.equal(live.chauffeurTriaged, stored.chauffeurTriaged);
      }

      assert.equal(delivered.get("triaged")?.chauffeurTriaged, true);
      assert.equal(
        Object.hasOwn(delivered.get("untriaged")!, "chauffeurTriaged"),
        false,
      );
    } finally {
      unsubscribe();
      await daemon.stop();
    }
  });

  test("a real SSE round trip carries a triaged mark and omits it when untriaged", async () => {
    const daemon = createDaemon();
    const record = await jiraMonitor(daemon);
    const server = await serveHttp({
      hostname: "127.0.0.1",
      port: 0,
      handler: (request) => handleDaemonHttpRequest(daemon, request, {}),
    });
    const client = await connectDaemonClient({
      name: "stream-triage-test",
      url: `http://127.0.0.1:${server.port}`,
    });
    let listener: { close(): Promise<void> } | undefined;

    try {
      const received: QueuedMonitorEvent[] = [];
      listener = await client.subscribe(target, async (events) => {
        received.push(...events);
      });

      await daemon.runtime.context.sink.deliver({
        monitor: record,
        event: commentEvent("triaged", record),
      });
      await daemon.runtime.context.sink.deliver({
        monitor: record,
        event: commentEvent("untriaged", record),
      });
      await until(() => received.length === 2);

      const delivered = eventsByID(received);
      const triaged = delivered.get("triaged");
      const untriaged = delivered.get("untriaged");
      assert.ok(triaged, "the client did not receive the triaged event");
      assert.ok(untriaged, "the client did not receive the untriaged event");
      assert.equal(triaged.chauffeurTriaged, true);
      assert.equal(Object.hasOwn(triaged, "chauffeurTriaged"), true);
      assert.equal(Object.hasOwn(untriaged, "chauffeurTriaged"), false);
    } finally {
      await listener?.close();
      await client.close();
      await server.stop();
      await daemon.stop();
    }
  });
});
