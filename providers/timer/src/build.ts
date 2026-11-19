import { parseAt } from "./at.ts"
import { parseDuration } from "./durations.ts"
import type { TimerCreateInput, TimerSource } from "./schema.ts"
import { addDuration, checkTimezone, systemTimezone, zonedIso } from "./zoned.ts"

/** The furthest ahead an `at` may be, the same bound a duration has. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1_000

/** Which of the three ways to say when a timer fires was given, with its text. */
type When = { field: "in" | "at" | "every"; text: string }

type Refusal = { error: string }

/**
 * Resolves create input against `now` once, so the stored source holds instants and a
 * restart or a later poll never reads `in` against a different clock.
 */
export function buildTimer(input: TimerCreateInput, now: Date): TimerSource | Refusal {
  const job = input.job?.trim()
  if (!job) return { error: "job is required for a timer monitor" }

  const when = pickWhen(input)
  if (!when) return { error: "give one of in, at or every" }

  const timezone = input.timezone ?? systemTimezone()
  const refused = checkTimezone(timezone)
  if (refused) return refused

  switch (when.field) {
    case "in":
      return oneShotIn(job, when.text, timezone, now)
    case "at":
      return oneShotAt(job, when.text, timezone, now)
    case "every":
      return interval(job, when.text, timezone, now)
  }
}

function pickWhen(input: TimerCreateInput): When | undefined {
  const given: When[] = []
  if (input.in !== undefined) given.push({ field: "in", text: input.in.trim() })
  if (input.at !== undefined) given.push({ field: "at", text: input.at.trim() })
  if (input.every !== undefined) given.push({ field: "every", text: input.every.trim() })
  return given.length === 1 ? given[0] : undefined
}

function oneShotIn(job: string, text: string, timezone: string, now: Date): TimerSource | Refusal {
  const duration = parseDuration(text, "in")
  if ("error" in duration) return duration

  return { type: "timer", job, due: zonedIso(addDuration(now, duration, timezone), timezone), timezone }
}

// A past `at` is kept: the first poll fires it at once.
function oneShotAt(job: string, text: string, timezone: string, now: Date): TimerSource | Refusal {
  const at = parseAt(text, timezone)
  if (!(at instanceof Date)) return at
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) return { error: "at must be within 366 days" }

  return { type: "timer", job, due: zonedIso(at, timezone), timezone }
}

function interval(job: string, text: string, timezone: string, now: Date): TimerSource | Refusal {
  const duration = parseDuration(text, "every")
  if ("error" in duration) return duration

  return { type: "timer", job, every: text, anchor: zonedIso(now, timezone), timezone }
}
