import type { Duration } from "./durations.ts"

/** A wall-clock reading in some zone; months and days count from 1. */
export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const DAY_MS = 24 * 60 * MINUTE_MS

/** The Mac's own zone, for a timer created without one. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// Intl reads an offset such as +05:30 or -0400 as a zone, but it has no rules and no name.
const FIXED_OFFSET = /^[+-]\d/

/** Refuses a name Intl does not know, and a fixed offset, so a stored timer always names an IANA zone. */
export function checkTimezone(name: string): { error: string } | undefined {
  if (FIXED_OFFSET.test(name)) return { error: `timezone "${name}" is not an IANA time zone` }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return undefined
  } catch {
    return { error: `timezone "${name}" is not an IANA time zone` }
  }
}

/** An ISO 8601 time with the zone's offset, such as `2026-11-19T15:20:00+05:30`; UTC is `+00:00`. */
export function zonedIso(date: Date, timeZone: string): string {
  const local = localTime(date, timeZone)
  const offset = offsetMs(date.getTime(), timeZone) / MINUTE_MS
  const sign = offset < 0 ? "-" : "+"
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  const day = `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`
  const clock = `${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`
  return `${day}T${clock}${sign}${pad(hours)}:${pad(minutes)}`
}

/**
 * The instant a wall-clock time names in a zone, as Temporal's "compatible" choice: a time
 * the clock skips moves forward by the gap, and a time the clock repeats is the earlier one.
 * Node 22 has no Temporal, so both offsets near the time are tried, from a day either side,
 * which no offset change in the tz database comes close to.
 */
export function resolveLocal(local: LocalTime, timeZone: string): Date {
  const wall = wallClock(local)
  const before = wall - offsetMs(wall - DAY_MS, timeZone)
  const after = wall - offsetMs(wall + DAY_MS, timeZone)
  const fits = (instant: number) => wallClock(localTime(new Date(instant), timeZone)) === wall

  if (fits(before) && fits(after)) return new Date(Math.min(before, after))
  if (fits(after)) return new Date(after)

  // In a gap neither fits; the offset from before the gap lands the time past it, by the gap.
  return new Date(before)
}

/** Weeks and days step the calendar keeping the wall time, then hours and minutes elapse. */
export function addDuration(from: Date, duration: Duration, timeZone: string): Date {
  const days = duration.weeks * 7 + duration.days
  const stepped = days === 0 ? from : stepDays(from, days, timeZone)
  return new Date(stepped.getTime() + (duration.hours * 60 + duration.minutes) * MINUTE_MS)
}

/** Milliseconds since the epoch of a wall-clock time read as if it were UTC; years below 100 stay as written. */
export function wallClock(local: LocalTime): number {
  const date = new Date(0)
  date.setUTCFullYear(local.year, local.month - 1, local.day)
  date.setUTCHours(local.hour, local.minute, local.second, 0)
  return date.getTime()
}

function stepDays(from: Date, days: number, timeZone: string): Date {
  const local = localTime(from, timeZone)
  // wallClock carries a day past the month's end into the next month.
  const next = new Date(wallClock({ ...local, day: local.day + days }))
  const resolved = resolveLocal(fromWall(next), timeZone)
  return new Date(resolved.getTime() + millisecondsOf(from.getTime()))
}

function fromWall(wall: Date): LocalTime {
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  }
}

function localTime(date: Date, timeZone: string): LocalTime {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  })
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, Number(part.value)]))
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  }
}

/** The zone's offset from UTC at an instant; the wall clock has no milliseconds, so neither does the instant compared. */
function offsetMs(instant: number, timeZone: string): number {
  const whole = instant - millisecondsOf(instant)
  return wallClock(localTime(new Date(whole), timeZone)) - whole
}

function millisecondsOf(instant: number): number {
  return ((instant % SECOND_MS) + SECOND_MS) % SECOND_MS
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}
