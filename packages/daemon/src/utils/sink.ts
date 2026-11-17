import type { MonitorEvent, MonitorEventQueue, MonitorEventSink, MonitorRecord, MonitorTarget } from "@sourcefed/core"
import type { EventTriage } from "../types/daemon.ts"

export class NotifyingEventSink implements MonitorEventSink {
  constructor(
    private readonly queue: MonitorEventQueue,
    private readonly notify: (target: MonitorTarget) => void,
    private readonly triage?: Pick<EventTriage, "decide">,
  ) {}

  async deliver(input: { monitor: MonitorRecord; event: MonitorEvent }): Promise<{ ok: boolean; error?: string }> {
    try {
      const decision = this.triage
        ? await this.triage.decide(input.monitor, input.event)
        : ({ deliver: true, triaged: false } as const)

      // A withheld event is queued for no host at all. The source cursor still
      // advances, so Chauffeur's verdict is the last word on it.
      if (!decision.deliver) return { ok: true }

      // The mark tells a host Chauffeur already vetted the event, so it must skip its own gate.
      await this.queue.enqueue({
        monitor: input.monitor,
        event: input.event,
        ...(decision.triaged ? { chauffeurTriaged: true } : {}),
      })
      this.notify(input.monitor.target)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
