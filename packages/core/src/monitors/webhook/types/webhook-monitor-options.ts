import type { MonitorSource } from "#sourcefed/sources";
import type { MonitorEvent } from "#sourcefed/types";

export type WebhookMonitorOptions = {
  path: string;
  preferred?: boolean;
  configured: () => boolean;
  verify: (body: string, request: Request) => boolean;
  acknowledgeBeforeDelivery?: boolean;
  /** Overrides exact-key routing: accept a delivery only when this returns true. Use it when `event.source` may be another source type. */
  matches?: (source: MonitorSource, event: MonitorEvent) => boolean;
  challenge?: (payload: unknown) => Record<string, string> | undefined;
  deliveryId: (request: Request, payload: unknown) => string | undefined;
  eventName: (request: Request, payload: unknown) => string;
  parse: (
    payload: unknown,
    eventName: string,
    deliveryId: string,
  ) => MonitorEvent | undefined;
  updateCursor?: (event: MonitorEvent, cursor: unknown) => unknown;
};
