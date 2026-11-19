import type { MonitorContext, MonitorEvent } from "#sourcefed/types"
import type { Monitor } from "../../monitor"

/** The source registered for an event's own type, or the webhook path's source when it has no registered type. */
export function selectEventSource(context: MonitorContext, source: Monitor, eventSource: unknown): Monitor {
  const type = (eventSource as { type?: unknown } | null | undefined)?.type
  const registered = typeof type === "string" ? context.sources[type] : undefined
  return registered ?? source
}

export async function deliverWebhook(context: MonitorContext, source: Monitor, event: MonitorEvent, deliveryId: string): Promise<number> {
  const deliverySource = selectEventSource(context, source, event.source)
  let delivered = 0
  const monitors = await context.service.list()
  for (const monitor of monitors) {
    if (monitor.source.type !== deliverySource.type) continue
    delivered += await deliverySource.deliver(context, monitor, event, deliveryId)
  }
  return delivered
}
