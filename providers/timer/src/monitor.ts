import { toMonitorEvent, type MonitorCreateInput } from "@sourcefed/core";
import { defineSource, type SourceDefinition } from "@sourcefed/sdk";
import { buildTimer } from "./build.ts";
import { timerKey } from "./events.ts";
import { pollTimer } from "./poll.ts";
import {
  TimerCursorSchema,
  TimerSourceSchema,
  type TimerSource,
} from "./schema.ts";

/** A one-shot or interval timer as data, plus the poll the host drives with its own clock. */
export const timerSource: SourceDefinition<TimerSource> = {
  type: "timer",
  schema: TimerSourceSchema,
  cursor: TimerCursorSchema,
  input: {
    description:
      "A timer: timer.fired once at a time (in or at), or at each period (every); one timer.missed for periods that came while sourcefed was stopped",
    properties: {
      job: {
        type: "string",
        minLength: 1,
        description: "What the timer is for, carried by every event's subject",
      },
      in: {
        type: "string",
        description:
          "Fire once after this long, e.g. 45m, 1h30m, 2d (1m to 366d)",
      },
      at: {
        type: "string",
        description:
          "Fire once at this time, e.g. 2026-11-19T15:00 in the timezone, or with an offset",
      },
      every: {
        type: "string",
        description:
          "Fire each period from now, e.g. 45m, 1h30m, 2d (1m to 366d)",
      },
      timezone: {
        type: "string",
        description:
          "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out",
      },
    },
    required: ["job"],
  },
  build: (input: MonitorCreateInput, now) => buildTimer(input, now()),
  key: timerKey,
  label: (source) => source.job,
  detail: (source) =>
    ("due" in source ? ` at ${source.due}` : ` every ${source.every}`) +
    ` ${source.timezone}`,
  describe: (source) =>
    "due" in source
      ? `Timer ${source.job} (at ${source.due})`
      : `Timer ${source.job} (every ${source.every})`,
  icon: "󰔛",
  defaultPollIntervalSec: 15,
  poll: async ({ source, cursor, now }) => {
    const result = pollTimer(source, cursor, now());

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: result.terminal,
    };
  },
};

/** The monitor the daemon registers. */
export const TimerMonitor = defineSource(timerSource);
