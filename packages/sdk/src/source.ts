import { Monitor, PollMonitor, WebhookMonitor } from "@sourcefed/core";
import type {
  MonitorCreateInput,
  MonitorEvent,
  MonitorSource,
  MonitorWake,
  SourceInput,
  SourceInputSchema,
  SourcePollResult,
  WebhookMonitorOptions,
} from "@sourcefed/core";
import type { GenericSchema } from "valibot";
import { fetchHttp, type Http } from "./http.ts";
import { hostMcpServers, stdioMcp, type Mcp } from "./mcp.ts";

/** What one poll is given. Cancellation and log lines arrive with the worker boundary, not this slice. */
export type SourceContext<T extends MonitorSource> = {
  readonly source: T;
  readonly cursor: unknown;
  readonly monitorId: string;
  readonly http: Http;
  /** The MCP servers the host runs: a source names one and calls its tool, and never starts a process. */
  readonly mcp: Mcp;
  /** The clock a source stamps events with, supplied by the host so a recorded poll replays at its recorded instant. */
  readonly now: () => Date;
};

/**
 * A source's webhook, as core's WebhookMonitor takes it, except that `verify` and `parse`
 * receive the host's clock: a signature's age and an event's fallback time are judged by the
 * host, so a recorded delivery replays at its recorded instant.
 */
export type SourceWebhook = Omit<WebhookMonitorOptions, "verify" | "parse"> & {
  readonly verify: (body: string, request: Request, now: () => Date) => boolean;
  readonly parse: (
    payload: unknown,
    eventName: string,
    deliveryId: string,
    now: () => Date,
  ) => MonitorEvent | undefined;
};

/** Everything a source is: its type and schema, its create input, its display, and its poll. */
export type SourceDefinition<T extends MonitorSource> = {
  readonly type: T["type"];
  readonly schema: GenericSchema<T>;
  /**
   * The shape of the cursor this source stores under its key. A stored cursor is checked
   * against it, and a later change of shape is a migration the source declares.
   */
  readonly cursor: GenericSchema<unknown>;
  readonly input: SourceInputSchema;
  /** Resolves create input into a source; one with relative input, such as a timer's `in`, reads the host's clock here. */
  readonly build: (input: MonitorCreateInput, now: () => Date) => SourceInput;
  readonly key: (source: T) => string;
  readonly label: (source: T) => string;
  readonly detail: (source: T) => string;
  readonly describe: (source: T) => string;
  readonly icon?: string;
  /** How often a new monitor of this source polls, in seconds, when the caller names no interval. */
  readonly defaultPollIntervalSec?: number;
  /** A webhook that only wakes the monitor for an early poll; the poll stays the source of truth. */
  readonly wake?: MonitorWake<T>;
  /** A webhook that delivers events itself, beside the poll; the daemon routes and retries them as core's do. */
  readonly webhook?: SourceWebhook;
  readonly poll: (context: SourceContext<T>) => Promise<SourcePollResult>;
  /**
   * How a poll's cursor is merged into the stored one, for a source whose webhook also writes
   * the cursor: without it a poll replaces whatever a delivery wrote since the poll began.
   */
  readonly mergeCursor?: (current: unknown, result: unknown) => unknown;
};

/** What the host gives a source. A test or the golden harness supplies its own http, MCP and clock. */
export type SourceHost = {
  readonly http: Http;
  readonly mcp: Mcp;
  readonly now: () => Date;
};

/**
 * Turns one definition into the core Monitor the daemon already knows, so a source is data
 * plus a poll function and the runtime above it is untouched.
 */
export function defineSource<T extends MonitorSource>(
  definition: SourceDefinition<T>,
  host: SourceHost = {
    http: fetchHttp(),
    mcp: stdioMcp(hostMcpServers),
    now: () => new Date(),
  },
): Monitor<T> {
  return new PluginMonitor(definition, host);
}

/** The Monitor core sees; every read of the definition happens here, and nowhere else. */
class PluginMonitor<T extends MonitorSource> extends Monitor<T> {
  readonly key: (source: T) => string;
  readonly label: (source: T) => string;
  readonly detail: (source: T) => string;
  readonly describe: (source: T) => string;
  readonly icon: string;
  readonly input: SourceInputSchema;
  readonly poll: PollMonitor<T>;
  // `declare` emits no field of its own, so the subclass adds no `wake` or `webhook` beyond what core's Monitor has.
  declare readonly wake?: MonitorWake<T>;
  declare readonly webhook?: WebhookMonitor<T>;
  declare readonly defaultPollIntervalSec?: number;

  constructor(
    private readonly definition: SourceDefinition<T>,
    private readonly host: SourceHost,
  ) {
    super({ type: definition.type, schema: definition.schema });

    this.key = definition.key;
    this.label = definition.label;
    this.detail = definition.detail;
    this.describe = definition.describe;
    this.icon = definition.icon ?? "";
    this.input = definition.input;
    // Assigned only when defined, so a source without a webhook leaves `wake` as core's old subclasses did.
    if (definition.wake) this.wake = definition.wake;
    if (definition.defaultPollIntervalSec !== undefined)
      this.defaultPollIntervalSec = definition.defaultPollIntervalSec;

    // The host's clock is closed over `verify` and `parse`, so core's WebhookMonitor calls them as it always has.
    const webhook = definition.webhook;
    if (webhook) {
      this.webhook = new WebhookMonitor<T>({
        ...webhook,
        verify: (body, request) => webhook.verify(body, request, host.now),
        parse: (payload, eventName, deliveryId) =>
          webhook.parse(payload, eventName, deliveryId, host.now),
      });
    }

    const run = (source: T, cursor: unknown, monitorId: string) =>
      definition.poll({
        source,
        cursor,
        monitorId,
        http: host.http,
        mcp: host.mcp,
        now: host.now,
      });
    // Passed only when defined, so a source without one keeps core's replace-the-cursor rule.
    this.poll = new PollMonitor<T>(
      definition.mergeCursor
        ? { run, mergeCursor: definition.mergeCursor }
        : { run },
    );
  }

  build(input: MonitorCreateInput): SourceInput {
    return this.definition.build(input, this.host.now);
  }
}
