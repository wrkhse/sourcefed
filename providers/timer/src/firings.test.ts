import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { firingsBetween } from "./firings.ts";
import type { TimerInterval } from "./schema.ts";
import { zonedIso } from "./zoned.ts";

const kolkata = "Asia/Kolkata";
const ny = "America/New_York";

function interval(
  every: string,
  anchor: string,
  timezone = kolkata,
): TimerInterval {
  return { type: "timer", job: "stretch", every, anchor, timezone };
}

function iso(date: Date | undefined, timezone = kolkata): string | undefined {
  return date && zonedIso(date, timezone);
}

describe("firingsBetween", () => {
  const stretch = interval("45m", "2026-11-19T09:00:00+05:30");

  test("an elapsed period counts the firings in the window", () => {
    const found = firingsBetween(
      stretch,
      new Date("2026-11-19T09:10:00+05:30"),
      new Date("2026-11-19T12:50:00+05:30"),
    );

    assert.equal(found?.count, 5);
    assert.equal(iso(found?.latest), "2026-11-19T12:45:00+05:30");
  });

  test("the window excludes its start and includes its end", () => {
    const first = new Date("2026-11-19T09:45:00+05:30");
    const second = new Date("2026-11-19T10:30:00+05:30");

    const atEnd = firingsBetween(
      stretch,
      new Date("2026-11-19T09:00:00+05:30"),
      first,
    );
    const afterStart = firingsBetween(stretch, first, second);

    assert.equal(atEnd?.count, 1);
    assert.equal(iso(atEnd?.latest), "2026-11-19T09:45:00+05:30");
    assert.equal(afterStart?.count, 1);
    assert.equal(iso(afterStart?.latest), "2026-11-19T10:30:00+05:30");
  });

  test("no firing in the window is undefined", () => {
    assert.equal(
      firingsBetween(
        stretch,
        new Date("2026-11-19T09:00:00+05:30"),
        new Date("2026-11-19T09:44:59+05:30"),
      ),
      undefined,
    );
  });

  test("a day keeps 09:00 across the spring-forward change", () => {
    const daily = interval("1d", "2026-03-06T09:00:00-05:00", ny);

    const found = firingsBetween(
      daily,
      new Date("2026-03-08T00:00:00-05:00"),
      new Date("2026-03-09T12:00:00-04:00"),
    );

    assert.equal(found?.count, 2);
    assert.equal(iso(found?.latest, ny), "2026-03-09T09:00:00-04:00");
  });

  test("a week steps the calendar", () => {
    const weekly = interval("1w", "2026-03-02T09:00:00-05:00", ny);

    const found = firingsBetween(
      weekly,
      new Date("2026-03-02T09:00:00-05:00"),
      new Date("2026-03-23T10:00:00-04:00"),
    );

    assert.equal(found?.count, 3);
    assert.equal(iso(found?.latest, ny), "2026-03-23T09:00:00-04:00");
  });

  test("a year's gap at one minute is counted without walking it", () => {
    const minutely = interval("1m", "2026-01-01T00:00:00+05:30");
    const started = performance.now();

    const found = firingsBetween(
      minutely,
      new Date("2026-01-01T00:00:00+05:30"),
      new Date("2027-01-01T00:00:00+05:30"),
    );

    assert.equal(found?.count, 365 * 24 * 60);
    assert.equal(iso(found?.latest), "2027-01-01T00:00:00+05:30");
    assert.ok(performance.now() - started < 1_000);
  });
});
