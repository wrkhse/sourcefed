import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as v from "valibot";
import { buildTimer } from "./build.ts";
import { TimerSourceSchema, type TimerCreateInput } from "./schema.ts";
import { systemTimezone, zonedIso } from "./zoned.ts";

// 15:00 in Kolkata.
const now = new Date("2026-11-19T09:30:00Z");
const job = "check the deploy";
const timezone = "Asia/Kolkata";

describe("buildTimer", () => {
  test("in is a one-shot due that long after now", () => {
    const source = buildTimer({ job, in: "20m", timezone }, now);

    assert.deepEqual(source, {
      type: "timer",
      job,
      due: "2026-11-19T15:20:00+05:30",
      timezone,
    });
    assert.deepEqual(v.parse(TimerSourceSchema, source), source);
  });

  test("in counts days on the calendar of the timezone", () => {
    const saturday = new Date("2026-03-07T14:00:00Z");

    const source = buildTimer(
      { job, in: "1d", timezone: "America/New_York" },
      saturday,
    );

    assert.deepEqual(source, {
      type: "timer",
      job,
      due: "2026-03-08T09:00:00-04:00",
      timezone: "America/New_York",
    });
  });

  test("at is a one-shot due at that local time", () => {
    assert.deepEqual(
      buildTimer({ job, at: "2026-11-19T18:00", timezone }, now),
      { type: "timer", job, due: "2026-11-19T18:00:00+05:30", timezone },
    );
  });

  test("at with an offset is written in the timezone", () => {
    assert.deepEqual(
      buildTimer({ job, at: "2026-11-19T15:00Z", timezone }, now),
      { type: "timer", job, due: "2026-11-19T20:30:00+05:30", timezone },
    );
  });

  test("every is an interval anchored at now", () => {
    const source = buildTimer({ job: "stretch", every: "45m", timezone }, now);

    assert.deepEqual(source, {
      type: "timer",
      job: "stretch",
      every: "45m",
      anchor: "2026-11-19T15:00:00+05:30",
      timezone,
    });
    assert.deepEqual(v.parse(TimerSourceSchema, source), source);
  });

  test("trims the job and the time", () => {
    assert.deepEqual(
      buildTimer({ job: " stretch ", every: " 45m ", timezone }, now),
      {
        type: "timer",
        job: "stretch",
        every: "45m",
        anchor: "2026-11-19T15:00:00+05:30",
        timezone,
      },
    );
  });

  test("a past at is kept, to fire at once", () => {
    assert.deepEqual(
      buildTimer({ job, at: "2026-11-18T09:00", timezone }, now),
      { type: "timer", job, due: "2026-11-18T09:00:00+05:30", timezone },
    );
  });

  test("at may be 366 days ahead and no more", () => {
    assert.deepEqual(
      buildTimer({ job, at: "2027-11-20T15:00", timezone }, now),
      { type: "timer", job, due: "2027-11-20T15:00:00+05:30", timezone },
    );
    assert.deepEqual(
      buildTimer({ job, at: "2027-11-20T15:01", timezone }, now),
      { error: "at must be within 366 days" },
    );
  });

  test("refuses a missing or blank job", () => {
    assert.deepEqual(buildTimer({ in: "20m", timezone }, now), {
      error: "job is required for a timer monitor",
    });
    assert.deepEqual(buildTimer({ job: "  ", in: "20m", timezone }, now), {
      error: "job is required for a timer monitor",
    });
  });

  test("refuses none, or more than one, of in, at and every", () => {
    assert.deepEqual(buildTimer({ job, timezone }, now), {
      error: "give one of in, at or every",
    });
    assert.deepEqual(
      buildTimer({ job, in: "20m", every: "1h", timezone }, now),
      { error: "give one of in, at or every" },
    );
    assert.deepEqual(
      buildTimer({ job, in: "20m", at: "2026-11-19T18:00", timezone }, now),
      { error: "give one of in, at or every" },
    );
  });

  test("passes on the reason a duration or time is refused", () => {
    assert.deepEqual(buildTimer({ job, in: "30s", timezone }, now), {
      error: "in must be at least 1m",
    });
    assert.deepEqual(buildTimer({ job, every: "367d", timezone }, now), {
      error: "every must be at most 366d",
    });
    assert.deepEqual(buildTimer({ job, at: "tomorrow", timezone }, now), {
      error: 'at "tomorrow" is not a time like 2026-11-19T15:00',
    });
  });

  test("refuses an unknown timezone", () => {
    assert.deepEqual(
      buildTimer({ job, in: "20m", timezone: "Mars/Olympus" }, now),
      { error: 'timezone "Mars/Olympus" is not an IANA time zone' },
    );
  });

  test("refuses a field that is present but not text", () => {
    const raw = (input: Record<string, unknown>) =>
      buildTimer(input as TimerCreateInput, now);

    assert.deepEqual(raw({ job, every: 45, timezone }), {
      error: "every must be text like 45m",
    });
    assert.deepEqual(raw({ job, in: { minutes: 20 }, timezone }), {
      error: "in must be text like 20m",
    });
    assert.deepEqual(raw({ job, at: 1_763_560_000_000, timezone }), {
      error: "at must be text like 2026-11-19T15:00",
    });
    assert.deepEqual(raw({ job: 7, in: "20m", timezone }), {
      error: "job must be text",
    });
    assert.deepEqual(raw({ job, in: "20m", timezone: { name: "UTC" } }), {
      error: "timezone must be text like Asia/Kolkata",
    });
  });

  test("uses the system's timezone when none is given", () => {
    const source = buildTimer({ job, in: "20m" }, now);

    assert.deepEqual(source, {
      type: "timer",
      job,
      due: zonedIso(new Date("2026-11-19T09:50:00Z"), systemTimezone()),
      timezone: systemTimezone(),
    });
  });
});
