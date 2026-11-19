import type { MonitorEventQueue, MonitorRecord, MonitorStore, MonitorTarget, QueuedMonitorEvent } from "@sourcefed/core"
import type { ChauffeurTriage } from "../triage/triage.ts"

/** Chauffeur v2 triage at the sink: the real ChauffeurTriage, or a fake in tests. */
export type EventTriage = Pick<ChauffeurTriage, "decide" | "close">

export type DaemonCreateInput = {
  name: string
  sourceType: string
  issueKey?: string
  repo?: string
  prNumber?: number
  channelId?: string
  threadTs?: string
  threadUrl?: string
  url?: string
  space?: string
  match?: string
  exclude?: string
  labels?: string[]
  issueNumbers?: number[]
  assignee?: string
  author?: string
  query?: string
  includeExisting?: boolean
  jql?: string
  cron?: string
  job?: string
  in?: string
  at?: string
  every?: string
  timezone?: string
  pollIntervalSec?: number
}

export type SourcefedDaemonOptions = {
  store?: MonitorStore
  eventQueue?: MonitorEventQueue
  stateDir?: string
  pollLoopSec?: number
  /** Chauffeur v2 triage at the sink; absent, every event is delivered untriaged. */
  triage?: EventTriage
}

export type MonitorView = {
  id: string
  name: string
  source: MonitorRecord["source"]
  target: MonitorRecord["target"]
  delivery: MonitorRecord["delivery"]
  pollIntervalSec: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  icon: string
  label: string
  detail: string
  describe: string
  unresponsive: boolean
  lastPolledAt?: string
  webhookHeartbeatAt?: string
}

export type LogEntryView = {
  id: string
  monitorID: string
  at: string
  kind: string
  summary: string
  body?: string
  actionable: boolean
  icon: string
  describe: string
}

export type DaemonResult =
  | { ok: true; created?: boolean; monitor?: MonitorView; monitors?: MonitorView[]; events?: QueuedMonitorEvent[]; logs?: LogEntryView[]; acknowledged?: string[]; removed?: boolean }
  | { ok: false; error: string }
