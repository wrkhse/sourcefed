import * as v from "valibot"
import type { SourceEvent } from "@sourcefed/core"
import { firedEvent, missedEvent } from "./events.ts"
import { firingsBetween } from "./firings.ts"
import { TimerCursorSchema, type TimerCursor, type TimerInterval, type TimerOneShot, type TimerSource } from "./schema.ts"
import { zonedIso } from "./zoned.ts"

/** A firing found within this long of it is on time. */
export const ON_TIME_MS = 2 * 60_000

type TimerPoll = { cursor: TimerCursor; events: SourceEvent[]; terminal: boolean }

/**
 * One poll at `now`. A one-shot fires once `now` reaches `due`, late or not, and ends. An
 * interval reports the firings since the last check: one on time is `timer.fired`, anything
 * else one `timer.missed`. Ids depend only on the firing, so a repeated poll repeats them.
 */
export function pollTimer(source: TimerSource, cursorRaw: unknown, now: Date): TimerPoll {
  const cursor = { checkedAt: now.toISOString() }
  if ("due" in source) return { cursor, ...pollOneShot(source, now) }

  return { cursor, events: pollInterval(source, cursorRaw, now), terminal: false }
}

function pollOneShot(source: TimerOneShot, now: Date): { events: SourceEvent[]; terminal: boolean } {
  const lateMs = now.getTime() - new Date(source.due).getTime()
  if (lateMs < 0) return { events: [], terminal: false }

  const event = firedEvent(source, source.due, source.timezone, lateMs > ON_TIME_MS ? lateMs : undefined)
  return { events: [event], terminal: true }
}

// The first poll does not prime: with no usable cursor the window starts at the anchor.
function pollInterval(source: TimerInterval, cursorRaw: unknown, now: Date): SourceEvent[] {
  const parsed = v.safeParse(TimerCursorSchema, cursorRaw)
  const checkedAt = parsed.success ? new Date(parsed.output.checkedAt) : new Date(Number.NaN)
  const after = Number.isNaN(checkedAt.getTime()) ? new Date(source.anchor) : checkedAt

  const firings = firingsBetween(source, after, now)
  if (!firings) return []

  const at = zonedIso(firings.latest, source.timezone)
  const onTime = firings.count === 1 && now.getTime() - firings.latest.getTime() <= ON_TIME_MS
  return [onTime ? firedEvent(source, at, source.timezone) : missedEvent(source, at, source.timezone, firings.count)]
}
