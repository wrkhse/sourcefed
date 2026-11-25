import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAt } from "./at.ts";

const instant = (text: string, timeZone: string) => {
  const at = parseAt(text, timeZone);
  return at instanceof Date ? at.toISOString() : at;
};

describe("parseAt", () => {
  test("a local time is read in the timezone", () => {
    assert.equal(
      instant("2026-11-19T15:00", "Asia/Kolkata"),
      "2026-11-19T09:30:00.000Z",
    );
    assert.equal(
      instant("2026-11-19T15:00", "America/New_York"),
      "2026-11-19T20:00:00.000Z",
    );
  });

  test("a local time takes seconds", () => {
    assert.equal(
      instant("2026-11-19T15:00:30", "Asia/Kolkata"),
      "2026-11-19T09:30:30.000Z",
    );
  });

  test("a local time in the spring-forward gap moves forward by the gap", () => {
    assert.equal(
      instant("2026-03-08T02:30", "America/New_York"),
      "2026-03-08T07:30:00.000Z",
    );
  });

  test("Z is UTC whatever the timezone", () => {
    assert.equal(
      instant("2026-11-19T15:00Z", "Asia/Kolkata"),
      "2026-11-19T15:00:00.000Z",
    );
  });

  test("an offset is an absolute instant whatever the timezone", () => {
    assert.equal(
      instant("2026-11-19T15:00:00-05:00", "Asia/Kolkata"),
      "2026-11-19T20:00:00.000Z",
    );
    assert.equal(
      instant("2026-11-19T15:00+05:30", "UTC"),
      "2026-11-19T09:30:00.000Z",
    );
  });

  test("refuses text that is not such a time", () => {
    assert.deepEqual(parseAt("tomorrow", "UTC"), {
      error: 'at "tomorrow" is not a time like 2026-11-19T15:00',
    });
    assert.deepEqual(parseAt("2026-11-19", "UTC"), {
      error: 'at "2026-11-19" is not a time like 2026-11-19T15:00',
    });
    assert.deepEqual(parseAt("2026-11-19 15:00", "UTC"), {
      error: 'at "2026-11-19 15:00" is not a time like 2026-11-19T15:00',
    });
    assert.deepEqual(parseAt("2026-11-19T15:00+25:00", "UTC"), {
      error: 'at "2026-11-19T15:00+25:00" is not a time like 2026-11-19T15:00',
    });
  });

  test("refuses a day or time the calendar does not have", () => {
    assert.deepEqual(parseAt("2026-02-30T10:00", "UTC"), {
      error: 'at "2026-02-30T10:00" is not a day and time on the calendar',
    });
    assert.deepEqual(parseAt("2026-11-19T24:00", "UTC"), {
      error: 'at "2026-11-19T24:00" is not a day and time on the calendar',
    });
    assert.deepEqual(parseAt("2026-11-19T15:60", "UTC"), {
      error: 'at "2026-11-19T15:60" is not a day and time on the calendar',
    });
  });
});
