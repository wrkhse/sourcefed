import {
  JsonMonitorEventQueue,
  JsonMonitorStore,
  MonitorRuntime,
  type MonitorEventQueue,
  type MonitorRecord,
  type MonitorStore,
  type MonitorTarget,
  type QueuedMonitorEvent,
} from "@sourcefed/core";
import {
  isSource,
  SOURCE_MAP,
  SOURCE_TYPES,
  sourceDefinition,
  sourceForInput,
  sourceForWebhookPath,
} from "./registry.ts";
import type {
  DaemonCreateInput,
  DaemonResult,
  EventTriage,
  LogEntryView,
  MonitorView,
  SourcefedDaemonOptions,
} from "./types";
import { NotifyingEventSink, targetKey } from "./utils";

const DELIVERY_LOG_LIMIT = 100;
/** Acknowledged deliveries remembered per target within one run; a restart is allowed to re-deliver. */
export const ADMITTED_LIMIT = 2048;
type DeliverySource = MonitorRecord["delivery"];

export class SourcefedDaemon {
  readonly runtime: MonitorRuntime;
  private readonly store: MonitorStore;
  private readonly queue: MonitorEventQueue;
  private readonly triage?: EventTriage;
  private readonly listeners = new Map<
    string,
    Set<(events: QueuedMonitorEvent[]) => void>
  >();
  private readonly observers = new Set<(target: MonitorTarget) => void>();
  private readonly received = new Map<
    string,
    Map<(events: QueuedMonitorEvent[]) => void, Set<string>>
  >();
  private readonly emitChains = new Map<string, Promise<void>>();
  private readonly deliveryLog = new Map<string, QueuedMonitorEvent[]>();
  /** Acknowledged event ids per target and the delivery source that admitted them, oldest first. */
  private readonly admitted = new Map<string, Map<string, DeliverySource>>();
  private releaseExclusive?: () => Promise<void>;
  private stopHearingEndings?: () => void;
  private started = false;

  constructor(options: SourcefedDaemonOptions = {}) {
    this.store =
      options.store ?? new JsonMonitorStore({ stateDir: options.stateDir });
    const queueDir =
      options.stateDir ??
      (this.store instanceof JsonMonitorStore
        ? this.store.stateDir
        : undefined) ??
      defaultStateDir();
    this.queue = options.eventQueue ?? new JsonMonitorEventQueue(queueDir);
    this.triage = options.triage;
    this.runtime = new MonitorRuntime({
      store: this.store,
      sink: new NotifyingEventSink(
        this.queue,
        (target) => this.emit(target),
        this.triage,
      ),
      sources: SOURCE_MAP,
      sourceForWebhookPath,
      pollLoopSec: options.pollLoopSec,
    });
  }

  get service() {
    return this.runtime.service;
  }

  get sourceTypes(): readonly string[] {
    return SOURCE_TYPES;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.store.acquireExclusive) {
      this.releaseExclusive = await this.store.acquireExclusive();
    }
    try {
      await this.removeAllDrainedEnded();
      // A session may take a monitor's last event before the monitor's ending is stored.
      this.stopHearingEndings = this.service.onEnd((monitor) =>
        this.removeDrainedEnded(monitor.target),
      );
      await this.runtime.start();
      this.started = true;
    } catch (error) {
      this.stopHearingEndings?.();
      this.stopHearingEndings = undefined;
      await this.releaseExclusive?.();
      this.releaseExclusive = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      const settled = await this.runtime.stop();

      if (!settled) {
        console.warn(
          "[sourcefed] monitor ticks still in flight; keeping exclusive ownership of the state directory",
        );
        return;
      }
      // The ticks have settled, so no poll ends a monitor after this.
      this.stopHearingEndings?.();
      this.stopHearingEndings = undefined;
      await this.releaseExclusive?.();
      this.releaseExclusive = undefined;
      this.started = false;
    } finally {
      // Closed even when ticks are still in flight, and even when a failing stop
      // throws past this method: a decide past this point settles untriaged
      // rather than hold the navigator open.
      this.triage?.close();
    }
  }

  async webhook(request: Request): Promise<Response> {
    return this.runtime.webhook(request);
  }

  async createMonitor(
    target: MonitorTarget,
    input: DaemonCreateInput,
  ): Promise<DaemonResult> {
    if (!(input.sourceType in SOURCE_MAP))
      return {
        ok: false,
        error: `unknown source type ${input.sourceType}; expected ${SOURCE_TYPES.join("|")}`,
      };
    const source = sourceForInput(input.sourceType, input);
    if (!isSource(source))
      return { ok: false, error: (source as { error: string }).error };
    const definition = sourceDefinition(source);
    const result = await this.service.create({
      name: input.name,
      source,
      delivery: definition.initialDelivery(source),
      target,
      pollIntervalSec:
        input.pollIntervalSec ?? definition.defaultPollIntervalSec ?? 60,
    });
    return {
      ok: true,
      created: result.created,
      monitor: monitorView(result.monitor),
    };
  }

  async listMonitors(target: MonitorTarget): Promise<DaemonResult> {
    // An ended monitor is finished; its record only waits for its last events to be taken.
    const monitors = (await this.service.list()).filter(
      (monitor) => !monitor.endedAt && sameTarget(monitor.target, target),
    );
    return { ok: true, monitors: monitors.map(monitorView) };
  }

  /**
   * Every target of `kind` with an enabled monitor, or an ended one whose last events
   * still wait, so a host that restarts can resubscribe the sessions whose monitors
   * outlived it.
   */
  async listTargets(kind: string): Promise<MonitorTarget[]> {
    const targets = new Map<string, MonitorTarget>();
    for (const monitor of await this.service.list()) {
      if (!isLive(monitor) || monitor.target.kind !== kind) continue;
      targets.set(targetKey(monitor.target), {
        kind: monitor.target.kind,
        id: monitor.target.id,
      });
    }
    return [...targets.values()];
  }

  async getMonitor(target: MonitorTarget, id: string): Promise<DaemonResult> {
    const monitor = await ownedMonitor(this.service, id, target);
    if (!monitor)
      return {
        ok: false,
        error: `monitor ${id} was not found for this target`,
      };
    return { ok: true, monitor: monitorView(monitor) };
  }

  async stopMonitor(target: MonitorTarget, id: string): Promise<DaemonResult> {
    const monitor = await ownedMonitor(this.service, id, target);
    if (!monitor)
      return {
        ok: false,
        error: `monitor ${id} was not found for this target`,
      };
    const stopped = await this.service.stop(id);
    if ("error" in stopped) return { ok: false, error: stopped.error };
    await this.purgeMonitorEvents(monitor.target, id);
    // With nothing queued the purge drops nothing, so an ended record would outlive its stop.
    await this.removeDrainedEnded(monitor.target);
    return { ok: true, monitor: monitorView(stopped) };
  }

  async startMonitor(target: MonitorTarget, id: string): Promise<DaemonResult> {
    const monitor = await ownedMonitor(this.service, id, target);
    if (!monitor)
      return {
        ok: false,
        error: `monitor ${id} was not found for this target`,
      };
    const started = await this.service.start(id);
    if ("error" in started) return { ok: false, error: started.error };
    return { ok: true, monitor: monitorView(started) };
  }

  async removeMonitor(
    target: MonitorTarget,
    id: string,
  ): Promise<DaemonResult> {
    const monitor = await ownedMonitor(this.service, id, target);
    if (!monitor)
      return {
        ok: false,
        error: `monitor ${id} was not found for this target`,
      };
    await this.service.remove(id);
    await this.purgeMonitorEvents(monitor.target, id);
    this.admitted.delete(targetKey(monitor.target));
    return { ok: true, removed: true };
  }

  async readEvents(target: MonitorTarget): Promise<QueuedMonitorEvent[]> {
    return this.queue.read(target);
  }

  async readLogs(target: MonitorTarget): Promise<LogEntryView[]> {
    return (this.deliveryLog.get(targetKey(target)) ?? []).map(logEntryView);
  }

  async acknowledgeEvents(
    target: MonitorTarget,
    eventIDs: string[],
  ): Promise<DaemonResult> {
    const queued = await this.queue.read(target);
    const acked = queued.filter((event) => eventIDs.includes(event.id));
    await this.queue.acknowledge(target, eventIDs);
    const monitors = await this.service.list();
    const deliveryByMonitor = new Map(
      monitors.map((monitor) => [monitor.id, monitor.delivery] as const),
    );
    this.admit(targetKey(target), acked, deliveryByMonitor);
    if (acked.length > 0) this.appendLog(target, acked);
    const receivedByListener = this.received.get(targetKey(target));
    if (receivedByListener) {
      const ids = new Set(eventIDs);
      for (const received of receivedByListener.values()) {
        for (const id of ids) received.delete(id);
      }
      for (const [listener, received] of receivedByListener) {
        if (received.size === 0) receivedByListener.delete(listener);
      }
    }
    await this.removeDrainedEnded(target);
    return { ok: true, acknowledged: eventIDs };
  }

  subscribe(
    target: MonitorTarget,
    onEvents: (events: QueuedMonitorEvent[]) => void,
  ): () => void {
    const key = targetKey(target);
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(onEvents);
    this.emit(target);
    return () => {
      listeners.delete(onEvents);
      const receivedByListener = this.received.get(key);
      const released = receivedByListener?.delete(onEvents) ?? false;
      if (listeners.size === 0) {
        this.listeners.delete(key);
        this.received.delete(key);
      } else if (released) {
        this.emit(target);
      }
    };
  }

  observe(onEvent: (target: MonitorTarget) => void): () => void {
    this.observers.add(onEvent);
    return () => this.observers.delete(onEvent);
  }

  private appendLog(target: MonitorTarget, events: QueuedMonitorEvent[]): void {
    const key = targetKey(target);
    const existing = this.deliveryLog.get(key) ?? [];
    const merged = [...events.reverse(), ...existing]; // newest first
    this.deliveryLog.set(key, merged.slice(0, DELIVERY_LOG_LIMIT));
  }

  private emit(target: MonitorTarget): void {
    for (const observer of this.observers) observer(target);
    const key = targetKey(target);
    const listeners = this.listeners.get(key);
    if (!listeners || listeners.size === 0) return;
    const previous = this.emitChains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(key, target, listeners))
      .catch((error) => {
        console.error(
          `[sourcefed] event delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.emitChains.set(key, next);
    void next.finally(() => {
      if (this.emitChains.get(key) === next) this.emitChains.delete(key);
    });
  }

  private async deliver(
    key: string,
    target: MonitorTarget,
    listeners: Set<(events: QueuedMonitorEvent[]) => void>,
  ): Promise<void> {
    const queued = await this.queue.read(target);
    if (queued.length === 0) return;

    // A stopped or removed monitor must go silent: drop its still-queued events
    // instead of replaying them to subscribers. An ended one still owes its last events.
    const monitors = await this.service.list();
    const liveMonitors = monitors.filter(isLive);
    const live = new Set(liveMonitors.map((monitor) => monitor.id));
    // Ended monitors still owe their last events, so their delivery source is
    // needed when an acknowledgement admits an id.
    const deliveryByMonitor = new Map(
      monitors.map((monitor) => [monitor.id, monitor.delivery] as const),
    );
    await this.dropQueued(
      target,
      queued
        .filter((event) => !live.has(event.monitorID))
        .map((event) => event.id),
    );

    let receivedByListener = this.received.get(key);
    if (!receivedByListener) {
      receivedByListener = new Map();
      this.received.set(key, receivedByListener);
    }
    const claimed = new Set<string>();
    for (const received of receivedByListener.values()) {
      for (const id of received) claimed.add(id);
    }
    const fresh = queued.filter(
      (event) => live.has(event.monitorID) && !claimed.has(event.id),
    );
    if (fresh.length === 0) return;

    // The queue can offer the same id again after an ack, or through another
    // delivery source after a switch; warn, then drop the stale copy so it does
    // not linger and warn again on every emit.
    const ledger = this.admitted.get(key);
    const suppressed: QueuedMonitorEvent[] = [];
    for (const event of fresh) {
      if (!ledger?.has(event.id)) continue;
      suppressed.push(event);
      const admittedVia = ledger.get(event.id);
      const receivedVia = deliveryByMonitor.get(event.monitorID);
      console.warn(
        `[sourcefed] duplicate delivery suppressed: ${event.id} (admitted via ${admittedVia ?? "unknown"}, received via ${receivedVia ?? "unknown"})`,
        { id: event.id, admittedVia, receivedVia },
      );
    }
    if (suppressed.length > 0)
      await this.dropQueued(
        target,
        suppressed.map((event) => event.id),
      );
    const deliverable = fresh.filter((event) => !ledger?.has(event.id));
    if (deliverable.length === 0) return;

    for (const listener of [...listeners]) {
      let received = receivedByListener.get(listener);
      if (!received) {
        received = new Set();
        receivedByListener.set(listener, received);
      }
      for (const event of deliverable) received.add(event.id);
      try {
        await listener(deliverable);
        return;
      } catch (error) {
        console.error(
          `[sourcefed] event delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        for (const event of deliverable) received.delete(event.id);
        if (received.size === 0) receivedByListener.delete(listener);
      }
    }
  }

  /** Remember only acknowledged deliveries, so an unacknowledged event is still delivered on reconnect. */
  private admit(
    key: string,
    events: QueuedMonitorEvent[],
    deliveryByMonitor: Map<string, DeliverySource>,
  ): void {
    let ledger = this.admitted.get(key);
    if (!ledger) {
      ledger = new Map();
      this.admitted.set(key, ledger);
    }
    for (const event of events) {
      const source = deliveryByMonitor.get(event.monitorID);
      if (!source) continue;
      ledger.set(event.id, source);
      evictOldestAdmitted(ledger);
    }
  }

  private async dropQueued(
    target: MonitorTarget,
    eventIDs: string[],
  ): Promise<void> {
    if (eventIDs.length === 0) return;
    await this.queue.acknowledge(target, eventIDs);
    const receivedByListener = this.received.get(targetKey(target));
    if (receivedByListener) {
      const ids = new Set(eventIDs);
      for (const received of receivedByListener.values()) {
        for (const id of ids) received.delete(id);
      }
    }
    await this.removeDrainedEnded(target);
  }

  /**
   * An ended monitor's record is kept only until the events it queued last are gone,
   * taken or dropped; then nothing is left for it to deliver.
   */
  private async removeDrainedEnded(target: MonitorTarget): Promise<void> {
    const ended = (await this.service.list()).filter(
      (monitor) => monitor.endedAt && sameTarget(monitor.target, target),
    );
    if (ended.length === 0) return;
    // Not atomic with the list on purpose: a record missed here goes at the next acknowledgement or start.
    const queued = new Set(
      (await this.queue.read(target)).map((event) => event.monitorID),
    );
    for (const monitor of ended) {
      if (!queued.has(monitor.id)) await this.service.remove(monitor.id);
    }
  }

  // A daemon that stopped between the last acknowledgement and the removal leaves the record.
  private async removeAllDrainedEnded(): Promise<void> {
    const targets = new Map<string, MonitorTarget>();
    for (const monitor of await this.service.list()) {
      if (monitor.endedAt)
        targets.set(targetKey(monitor.target), monitor.target);
    }
    for (const target of targets.values())
      await this.removeDrainedEnded(target);
  }

  private async purgeMonitorEvents(
    target: MonitorTarget,
    monitorID: string,
  ): Promise<void> {
    const queued = await this.queue.read(target);
    await this.dropQueued(
      target,
      queued
        .filter((event) => event.monitorID === monitorID)
        .map((event) => event.id),
    );
  }
}

/** Map iteration is insertion order, so the oldest admission is the first key. */
export function evictOldestAdmitted<T>(
  ledger: Map<string, T>,
  limit = ADMITTED_LIMIT,
): void {
  while (ledger.size > limit) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) return;
    ledger.delete(oldest);
  }
}

export function monitorView(monitor: MonitorRecord): MonitorView {
  const definition = sourceDefinition(monitor.source);
  return {
    id: monitor.id,
    name: monitor.name,
    source: monitor.source,
    target: monitor.target,
    delivery: monitor.delivery,
    pollIntervalSec: monitor.pollIntervalSec,
    enabled: monitor.enabled,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    icon: definition.icon,
    label: definition.label(monitor.source),
    detail: definition.detail(monitor.source),
    describe: definition.describe(monitor.source),
    unresponsive: definition.unresponsive(monitor),
    lastPolledAt: cursorTime(
      monitor.cursors.__lastPolledAt ?? monitor.cursors.__lastAttemptAt,
    ),
    webhookHeartbeatAt: cursorTime(monitor.cursors.__webhookHeartbeatAt),
  };
}

function cursorTime(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric).toISOString();
}

export function logEntryView(queued: QueuedMonitorEvent): LogEntryView {
  const definition = sourceDefinition(queued.event.source as { type: string });
  return {
    id: queued.id,
    monitorID: queued.monitorID,
    at: queued.event.at,
    kind: queued.event.kind,
    summary: queued.event.summary,
    body: queued.event.body,
    actionable: queued.event.actionable,
    icon: definition.icon,
    describe: definition.describe(queued.event.source as never),
  };
}

async function ownedMonitor(
  service: SourcefedDaemon["service"],
  id: string,
  target: MonitorTarget,
): Promise<MonitorRecord | undefined> {
  const monitor = await service.get(id);
  return monitor && sameTarget(monitor.target, target) ? monitor : undefined;
}

function sameTarget(left: MonitorTarget, right: MonitorTarget): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/** A monitor whose queued events are delivered: enabled, or ended, whose record lasts only while its last events wait. */
function isLive(monitor: MonitorRecord): boolean {
  return monitor.enabled || Boolean(monitor.endedAt);
}

function defaultStateDir(): string {
  return (
    process.env.SOURCEFED_STATE_DIR ??
    `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? "."}/.local/state`}/sourcefed`
  );
}
