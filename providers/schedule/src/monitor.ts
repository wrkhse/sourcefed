import { toMonitorEvent, type MonitorCreateInput, type SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { checkSchedule, systemTimezone } from "./firings.ts"
import { pollSchedule } from "./poll.ts"
import { ScheduleCursorSchema, ScheduleSourceSchema, type ScheduleSource } from "./schema.ts"

/** A cron schedule as data, plus the poll the host drives with its own clock. */
export const scheduleSource: SourceDefinition<ScheduleSource> = {
  type: "schedule",
  schema: ScheduleSourceSchema,
  cursor: ScheduleCursorSchema,
  input: {
    description: "A cron schedule: schedule.fired at each time, or one schedule.missed for times that came while sourcefed was stopped",
    properties: {
      cron: { type: "string", minLength: 1, description: "A cron expression, e.g. '0 2 * * *' for 02:00 every day" },
      job: { type: "string", minLength: 1, description: "The job's name, carried by every event's subject" },
      timezone: { type: "string", description: "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out" },
    },
    required: ["cron", "job"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    const cron = input.cron?.trim()
    const job = input.job?.trim()
    if (!cron) return { error: "cron is required for a schedule monitor" }
    if (!job) return { error: "job is required for a schedule monitor" }

    try {
      checkSchedule(cron, input.timezone ?? systemTimezone())
    } catch (error) {
      return { error: `invalid schedule: ${error instanceof Error ? error.message : String(error)}` }
    }

    const source: ScheduleSource = { type: "schedule", cron, job }
    if (input.timezone) source.timezone = input.timezone
    return source
  },
  key: (source) => `schedule:${source.job}:${source.cron}:${source.timezone ?? ""}`,
  label: (source) => source.job,
  detail: (source) => ` ${source.cron}${source.timezone ? ` ${source.timezone}` : ""}`,
  describe: (source) => `Schedule ${source.job} (${source.cron})`,
  icon: "󰃰",
  defaultPollIntervalSec: 15,
  poll: async ({ source, cursor, now }) => {
    const result = pollSchedule(source, cursor, now())

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: false,
    }
  },
}

/** The monitor the daemon registers. */
export const ScheduleMonitor = defineSource(scheduleSource)
