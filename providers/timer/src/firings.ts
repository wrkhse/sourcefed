import { PollSourceError } from "@sourcefed/core"
import { parseDuration, type Duration } from "./durations.ts"
import type { TimerInterval } from "./schema.ts"
import { addDuration } from "./zoned.ts"

const MINUTE_MS = 60_000

// A clock change moves a calendar firing at most a few hours from the nominal estimate,
// so the correction takes a handful of steps; past this the stored source is broken.
const MAX_CORRECTIONS = 64

/**
 * The firings of an interval in (after, until]: how many, and the latest. The k-th firing is
 * k periods from the anchor, so a calendar step never drifts and a long gap costs no more
 * than a short one.
 */
export function firingsBetween(source: TimerInterval, after: Date, until: Date): { latest: Date; count: number } | undefined {
  const duration = parseDuration(source.every, "every")
  if ("error" in duration) throw new PollSourceError(`timer every "${source.every}" in the stored source does not parse`)

  const anchor = new Date(source.anchor)
  const firing = (k: number) => addDuration(anchor, scale(duration, k), source.timezone)
  const last = lastFiringAtOrBefore(firing, nominalMs(duration), anchor, until)
  const count = last - lastFiringAtOrBefore(firing, nominalMs(duration), anchor, after)
  if (count <= 0) return undefined

  return { latest: firing(last), count }
}

/** The largest k with firing(k) ≤ t, and 0 when t is before the first firing. */
function lastFiringAtOrBefore(firing: (k: number) => Date, periodMs: number, anchor: Date, t: Date): number {
  const time = t.getTime()
  if (time <= anchor.getTime()) return 0

  let k = Math.floor((time - anchor.getTime()) / periodMs)
  for (let step = 0; step < MAX_CORRECTIONS; step += 1) {
    if (firing(k + 1).getTime() <= time) k += 1
    else if (k > 0 && firing(k).getTime() > time) k -= 1
    else return k
  }

  throw new PollSourceError(`timer firings did not settle near ${t.toISOString()}`)
}

function scale(duration: Duration, k: number): Duration {
  return { weeks: duration.weeks * k, days: duration.days * k, hours: duration.hours * k, minutes: duration.minutes * k }
}

function nominalMs(duration: Duration): number {
  return ((duration.weeks * 7 + duration.days) * 24 * 60 + duration.hours * 60 + duration.minutes) * MINUTE_MS
}
