import type { MonitorEvent } from "./monitor-event.ts";
import type { MonitorTarget } from "./monitor-target.ts";
import type { MonitorRecord } from "../monitors/types/monitor-record.ts";

export type QueuedMonitorEvent = {
  id: string;
  monitorID: string;
  target: MonitorTarget;
  event: MonitorEvent;
  queuedAt: string;
  /**
   * Set when Chauffeur v2 triaged the event at the daemon's sink and let it
   * through, so a host skips its own v1 gate. Absent otherwise; never false.
   */
  chauffeurTriaged?: true;
};

export interface MonitorEventQueue {
  enqueue(input: {
    monitor: MonitorRecord;
    event: MonitorEvent;
    chauffeurTriaged?: boolean;
  }): Promise<QueuedMonitorEvent>;
  read(target: MonitorTarget): Promise<QueuedMonitorEvent[]>;
  acknowledge(target: MonitorTarget, eventIDs: string[]): Promise<void>;
}
