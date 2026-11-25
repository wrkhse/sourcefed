import type { MonitorContext } from "#sourcefed/types";
import type { Monitor } from "../../monitor";
import { selectEventSource } from "./deliver-webhook.ts";

export async function heartbeatWebhooks(
  context: MonitorContext,
  source: Monitor,
  eventSource: unknown,
): Promise<void> {
  const deliverySource = selectEventSource(context, source, eventSource);
  const sourceKey = deliverySource.key(
    deliverySource.validateSource(eventSource),
  );
  const monitors = await context.service.list();
  for (const monitor of monitors) {
    if (!monitor.enabled || monitor.source.type !== deliverySource.type)
      continue;
    if (
      deliverySource.key(deliverySource.validateSource(monitor.source)) !==
      sourceKey
    )
      continue;
    await context.service.updateCursor(
      monitor,
      "__webhookHeartbeatAt",
      Date.now(),
    );
  }
}
