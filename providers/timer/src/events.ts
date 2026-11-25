import type { SourceEvent } from "@sourcefed/core";
import type { TimerSource } from "./schema.ts";

const MINUTE_MS = 60_000;

/** The key a timer's monitor is stored under, and so the scope of its event ids. */
export function timerKey(source: TimerSource): string {
  return "due" in source
    ? `timer:${source.job}:${source.due}`
    : `timer:${source.job}:${source.every}:${source.anchor}`;
}

/** A firing; a one-shot found late carries how late, since it fires only once. */
export function firedEvent(
  source: TimerSource,
  at: string,
  timezone: string,
  lateMs?: number,
): SourceEvent {
  const late = lateMs === undefined ? "" : `, ${delay(lateMs)} late`;
  const subject = {
    type: "timer",
    key: source.job,
    job: source.job,
    at,
    timezone,
    ...every(source),
  };
  return {
    kind: "timer.fired",
    id: firingId(source, at),
    at,
    summary: `Timer ${source.job} fired at ${at}${late}`,
    actionable: true,
    subject:
      lateMs === undefined
        ? subject
        : { ...subject, late: true, lateSec: Math.floor(lateMs / 1_000) },
  };
}

/** The firings of an interval that came while nobody polled, as one event. */
export function missedEvent(
  source: TimerSource,
  at: string,
  timezone: string,
  missed: number,
): SourceEvent {
  const times =
    missed === 1 ? "1 time" : `${missed.toLocaleString("en")} times`;
  return {
    kind: "timer.missed",
    id: firingId(source, at),
    at,
    summary: `Timer ${source.job} missed ${times}; the latest was ${at}`,
    body: "Sourcefed was not running, or the Mac was asleep, when these times came. This one event stands for all of them.",
    actionable: true,
    subject: {
      type: "timer",
      key: source.job,
      job: source.job,
      at,
      timezone,
      ...every(source),
      missed,
    },
  };
}

// One id per firing whatever its kind, so a firing sent on time and again late after a
// crash before the cursor write is one event in the queue.
function firingId(source: TimerSource, at: string): string {
  return `timer:${timerKey(source)}:${at}`;
}

function every(source: TimerSource): { every?: string } {
  return "every" in source ? { every: source.every } : {};
}

/** The two largest non-zero units: `45m`, `3h 20m`, `2d 4h`, `1d`. */
function delay(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  const parts: [number, string][] = [
    [Math.floor(minutes / (24 * 60)), "d"],
    [Math.floor((minutes % (24 * 60)) / 60), "h"],
    [minutes % 60, "m"],
  ];
  const shown = parts.filter(([value]) => value > 0).slice(0, 2);
  return shown.length === 0
    ? "0m"
    : shown.map(([value, unit]) => `${value}${unit}`).join(" ");
}
