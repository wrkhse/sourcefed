/** A duration's parts as written. Weeks and days are calendar steps, hours and minutes elapsed time, so they stay apart. */
export type Duration = { weeks: number; days: number; hours: number; minutes: number }

/** The create-input field a duration came from, named in every refusal. */
export type DurationField = "in" | "every"

const MINUTES_PER_DAY = 24 * 60
const MAX_DAYS = 366

// Each unit at most once, largest first, no spaces: one reading per text.
const DURATION = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/

// Seconds are below the smallest unit, so a few seconds is refused as too short, not as unreadable.
const SECONDS = /^(\d+)s$/

/** Reads `45m`, `1h30m`, `2w` or `1d12h`, between 1 minute and 366 days long. */
export function parseDuration(text: string, field: DurationField): Duration | { error: string } {
  const seconds = SECONDS.exec(text)
  if (seconds && Number(seconds[1]) < 60) return { error: `${field} must be at least 1m` }

  const match = DURATION.exec(text)
  if (!text || !match) return { error: `${field} "${text}" is not a duration like 45m, 1h30m or 2d` }

  const duration: Duration = {
    weeks: Number(match[1] ?? 0),
    days: Number(match[2] ?? 0),
    hours: Number(match[3] ?? 0),
    minutes: Number(match[4] ?? 0),
  }

  const minutes = nominalMinutes(duration)
  if (minutes < 1) return { error: `${field} must be at least 1m` }
  if (minutes > MAX_DAYS * MINUTES_PER_DAY) return { error: `${field} must be at most ${MAX_DAYS}d` }

  return duration
}

/** The length with every day 24 hours long, which is what the bounds measure. */
function nominalMinutes(duration: Duration): number {
  const days = duration.weeks * 7 + duration.days
  return days * MINUTES_PER_DAY + duration.hours * 60 + duration.minutes
}
