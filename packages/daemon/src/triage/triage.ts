import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import { discover as discoverChauffeur, type ChauffeurEndpoint } from "./discover.ts"
import { triageEvidence, type TriageEvidence } from "./evidence.ts"

/** The longest one event may wait for Chauffeur's verdict, probe included. */
export const TRIAGE_DEADLINE_MS = 3_000

/** How long an absent or unreachable Chauffeur is left alone before another probe. */
export const REPROBE_INTERVAL_MS = 30_000

export type TriageIntent = { readonly rule: string; readonly [intent: string]: unknown }

export type TriageRequest = { on: "sourcefed.event"; deadline_ms: number; evidence: TriageEvidence }

/**
 * The narrow part of @fdcn/chauffeur/client's connection the daemon relies on,
 * declared here until the package is a dependency. An unavailable Chauffeur
 * rejects with a reason of "unavailable"; other reasons ("busy", "limit_exceeded",
 * "deadline", "cancelled", ...) only mean this event went untriaged.
 */
export type Navigator = {
  navigate(request: TriageRequest, options: { signal: AbortSignal }): Promise<{ intents: readonly TriageIntent[] }>
  close(): void
}

export type TriageDecision = { deliver: false } | { deliver: true; triaged: boolean }

/** One decide's deadline: a ref'd timer that aborts its signal, cleared when the decide or close ends it. */
type Deadline = { readonly signal: AbortSignal; abort(): void; clear(): void }

export type ChauffeurTriageOptions = {
  connect: (endpoint: ChauffeurEndpoint) => Navigator
  /** Defaults to the real socket discovery; tests replace it with a fake. */
  discover?: () => Promise<ChauffeurEndpoint | undefined>
  /** Defaults to Date.now; tests cross REPROBE_INTERVAL_MS with a fake clock. */
  now?: () => number
  /** Defaults to TRIAGE_DEADLINE_MS; tests shorten it. */
  deadlineMs?: number
  /** Defaults to console.error. */
  log?: (line: string) => void
}

const UNTRIAGED: TriageDecision = { deliver: true, triaged: false }
const TRIAGED: TriageDecision = { deliver: true, triaged: true }
const WITHHELD: TriageDecision = { deliver: false }

type Verdict =
  | { kind: "result"; result: unknown }
  | { kind: "rejected"; reason: string | undefined }
  | { kind: "deadline" }

/**
 * Chauffeur v2's verdict for each event at the daemon's sink. Only an explicit
 * withhold intent withholds; a missing, incompatible, slow or failing Chauffeur
 * delivers the event untriaged, never more than the deadline late.
 */
export class ChauffeurTriage {
  private readonly connect: (endpoint: ChauffeurEndpoint) => Navigator
  private readonly discover: () => Promise<ChauffeurEndpoint | undefined>
  private readonly now: () => number
  private readonly deadlineMs: number
  private readonly log: (line: string) => void
  private navigator: Navigator | undefined
  private probing: Promise<ChauffeurEndpoint | undefined> | undefined
  private lastProbe: number | undefined
  private reportedUnavailable = false
  private closed = false
  /** Every decide still waiting on a verdict, so close() can settle each at once. */
  private readonly deadlines = new Set<Deadline>()

  constructor(options: ChauffeurTriageOptions) {
    this.connect = options.connect
    this.discover = options.discover ?? (() => discoverChauffeur())
    this.now = options.now ?? Date.now
    this.deadlineMs = options.deadlineMs ?? TRIAGE_DEADLINE_MS
    this.log = options.log ?? ((line) => console.error(line))
  }

  /** Decides one event; it never rejects, because a failed verdict must not stop delivery. */
  async decide(monitor: MonitorRecord, event: MonitorEvent): Promise<TriageDecision> {
    if (this.closed) return UNTRIAGED

    try {
      return await this.verdict(monitor, event)
    } catch {
      return UNTRIAGED
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true

    const navigator = this.navigator
    this.navigator = undefined
    if (navigator) closeQuietly(navigator)

    // Each waiting decide settles untriaged now, so no deadline outlives close.
    const pending = [...this.deadlines]
    this.deadlines.clear()
    for (const deadline of pending) deadline.abort()
  }

  private async verdict(monitor: MonitorRecord, event: MonitorEvent): Promise<TriageDecision> {
    // One deadline for both the probe and the call, so a slow probe cannot add to the wait.
    const deadline = startDeadline(this.deadlineMs)
    this.deadlines.add(deadline)

    try {
      const navigator = await this.navigatorFor(deadline.signal)
      // A deadline reached during the probe leaves no navigator to blame.
      if (!navigator || deadline.signal.aborted) return UNTRIAGED

      const asked = await this.ask(navigator, monitor, event, deadline.signal)
      if (asked.kind === "result") return triageDecision(asked.result)

      // A navigator that neither answered nor rejected before the deadline is lost, not merely slow.
      if (asked.kind === "deadline" || asked.reason === "unavailable") this.drop(navigator)

      return UNTRIAGED
    } finally {
      // The timer must not outlive the decide, or a settled verdict would hold the loop open.
      deadline.clear()
      this.deadlines.delete(deadline)
    }
  }

  private async navigatorFor(signal: AbortSignal): Promise<Navigator | undefined> {
    if (this.navigator) return this.navigator

    const probing = this.probing ?? this.startProbe()
    if (!probing) return undefined

    // The probe connects its own endpoint; the deadline only bounds how long this decide waits.
    await until(probing, signal)
    return this.navigator
  }

  private startProbe(): Promise<ChauffeurEndpoint | undefined> | undefined {
    if (this.lastProbe !== undefined && this.now() - this.lastProbe < REPROBE_INTERVAL_MS) return undefined

    // Recorded when the probe starts, so failures and concurrent decides share one interval.
    this.lastProbe = this.now()
    const probing = probeQuietly(this.discover).then((endpoint) => {
      // Connecting here keeps an endpoint that arrives after every waiting decide's deadline.
      if (endpoint && !this.closed && !this.navigator) this.navigator = this.connectTo(endpoint)
      return endpoint
    })
    this.probing = probing
    const clear = () => {
      if (this.probing === probing) this.probing = undefined
    }
    void probing.then(clear, clear)

    return probing
  }

  private connectTo(endpoint: ChauffeurEndpoint): Navigator | undefined {
    let navigator: Navigator
    try {
      navigator = this.connect(endpoint)
    } catch {
      return undefined
    }

    // A working connection starts a new episode, so the next loss is reported again.
    this.reportedUnavailable = false
    this.log(`[sourcefed] Chauffeur v2 ${endpoint.version} at ${endpoint.socket}: events are triaged before delivery`)
    return navigator
  }

  private ask(navigator: Navigator, monitor: MonitorRecord, event: MonitorEvent, signal: AbortSignal): Promise<Verdict> {
    if (signal.aborted) return Promise.resolve({ kind: "deadline" })

    const request: TriageRequest = {
      on: "sourcefed.event",
      deadline_ms: this.deadlineMs,
      evidence: triageEvidence(monitor, event),
    }

    let call: Promise<{ intents: readonly TriageIntent[] }>
    try {
      call = navigator.navigate(request, { signal })
    } catch (error) {
      return Promise.resolve({ kind: "rejected", reason: errorReason(error) })
    }

    return new Promise((resolve) => {
      const finish = (verdict: Verdict) => {
        signal.removeEventListener("abort", onAbort)
        resolve(verdict)
      }
      const onAbort = () => finish({ kind: "deadline" })

      signal.addEventListener("abort", onAbort, { once: true })
      // A navigator that ignores the signal still loses the race at the deadline.
      call.then(
        (result) => finish({ kind: "result", result }),
        (error) => finish({ kind: "rejected", reason: errorReason(error) }),
      )
    })
  }

  /** Drops the navigator this failure belongs to; each loss after a working connect is reported once. */
  private drop(navigator: Navigator): void {
    // A late failure from an already dropped navigator must not report a second loss.
    if (this.navigator !== navigator) return

    this.navigator = undefined
    closeQuietly(navigator)
    // The loss restarts the probe interval, so a dead navigator costs one event, not every event.
    this.lastProbe = this.now()
    if (this.reportedUnavailable) return

    this.reportedUnavailable = true
    this.log("[sourcefed] Chauffeur v2 went away; delivering events untriaged until it is back")
  }
}

function triageDecision(result: unknown): TriageDecision {
  const withholds = withholdsEvent(result)
  if (withholds === undefined) return UNTRIAGED
  return withholds ? WITHHELD : TRIAGED
}

/** Whether any intent explicitly withholds the event, or undefined for a malformed result. */
function withholdsEvent(result: unknown): boolean | undefined {
  if (typeof result !== "object" || result === null) return undefined

  const intents = (result as { intents?: unknown }).intents
  if (!Array.isArray(intents)) return undefined

  return intents.some((intent: unknown) => (
    typeof intent === "object"
    && intent !== null
    && (intent as { withhold?: unknown }).withhold === "event"
  ))
}

/** Probes without ever rejecting: a discovery failure is simply no endpoint. */
function probeQuietly(discover: () => Promise<ChauffeurEndpoint | undefined>): Promise<ChauffeurEndpoint | undefined> {
  try {
    return Promise.resolve(discover()).then((endpoint) => endpoint, () => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

/**
 * Starts one decide's deadline. The timer is deliberately ref'd: with no other
 * handle alive, an unref'd timer lets Node exit before the deadline fires.
 */
function startDeadline(deadlineMs: number): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadlineMs)

  return {
    signal: controller.signal,
    abort: () => {
      clearTimeout(timer)
      controller.abort()
    },
    clear: () => clearTimeout(timer),
  }
}

/** Resolves with the value, or undefined once the signal aborts; the work itself keeps running. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    const abort = () => resolve(undefined)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()

    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      () => {
        signal.removeEventListener("abort", abort)
        resolve(undefined)
      },
    )
  })
}

function errorReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined

  const reason = (error as { reason?: unknown }).reason
  return typeof reason === "string" ? reason : undefined
}

function closeQuietly(navigator: Navigator): void {
  try {
    navigator.close()
  } catch {
    // A navigator that fails to close must not turn into a failed decide.
  }
}
