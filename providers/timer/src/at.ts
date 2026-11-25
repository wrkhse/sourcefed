import { resolveLocal, wallClock, type LocalTime } from "./zoned.ts";

const MINUTE_MS = 60_000;

// A day and a time to the minute or second, then Z, an offset up to ±14:59, or nothing for local time.
const AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/;

/** Reads `2026-11-19T15:00` as local time in the zone, or with `Z` or `+05:30` as that instant. */
export function parseAt(
  text: string,
  timeZone: string,
): Date | { error: string } {
  const match = AT.exec(text);
  if (!match)
    return { error: `at "${text}" is not a time like 2026-11-19T15:00` };

  const local: LocalTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (!onCalendar(local))
    return { error: `at "${text}" is not a day and time on the calendar` };

  const zone = match[7];
  if (zone === undefined) return resolveLocal(local, timeZone);
  return new Date(wallClock(local) - offsetMinutes(zone) * MINUTE_MS);
}

/** Whether the fields survive a round trip through the calendar, which carries a 30 February or a 24:00 forward. */
function onCalendar(local: LocalTime): boolean {
  const wall = new Date(wallClock(local));
  return (
    wall.getUTCFullYear() === local.year &&
    wall.getUTCMonth() + 1 === local.month &&
    wall.getUTCDate() === local.day &&
    wall.getUTCHours() === local.hour &&
    wall.getUTCMinutes() === local.minute &&
    wall.getUTCSeconds() === local.second
  );
}

function offsetMinutes(zone: string): number {
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
}
