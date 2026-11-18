import type { MonitorEvent, MonitorEventQueue, MonitorEventSink, MonitorRecord, MonitorTarget } from "@sourcefed/core"
import type { TriageDecision } from "../triage/triage.ts"
import type { EventTriage } from "../types/daemon.ts"

export class NotifyingEventSink implements MonitorEventSink {
  constructor(
    private readonly queue: MonitorEventQueue,
    private readonly notify: (target: MonitorTarget) => void,
    private readonly triage?: Pick<EventTriage, "decide">,
    /** A withheld event is invisible to every host, so the log is the only place it can be accounted for. */
    private readonly log: (line: string) => void = console.error,
  ) {}

  async deliver(input: { monitor: MonitorRecord; event: MonitorEvent }): Promise<{ ok: boolean; error?: string }> {
    const decision = await this.decisionFor(input)

    // A withheld event is queued for no host at all. The source cursor still
    // advances, so Chauffeur's verdict is the last word on it.
    if (!decision.deliver) {
      this.log(`[sourcefed] withheld event=${input.event.id ?? "none"} monitor=${input.monitor.id} rule=${decision.rule || "none"}: ${input.event.summary}`)
      return { ok: true }
    }

    try {
      // The mark tells a host Chauffeur already vetted the event, so it must skip its own gate.
      await this.queue.enqueue({
        monitor: input.monitor,
        event: input.event,
        ...(decision.triaged ? { chauffeurTriaged: true } : {}),
      })
      this.notify(input.monitor.target)
      return { ok: true }
    } catch (error) {
      // Only a failed enqueue is retryable: the poll keeps its cursor and offers the event again.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Triage is advisory, so a decide that throws or rejects must not fail the
   * delivery: the poll would keep the event and retry it, which is the opposite
   * of fail-open. An unanswered verdict delivers the event unmarked instead, so
   * the host still applies its own gate.
   */
  private async decisionFor(input: { monitor: MonitorRecord; event: MonitorEvent }): Promise<TriageDecision> {
    if (!this.triage) return { deliver: true, triaged: false }

    try {
      return await this.triage.decide(input.monitor, input.event)
    } catch {
      return { deliver: true, triaged: false }
    }
  }
}
