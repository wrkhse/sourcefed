import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { addDuration, checkTimezone, resolveLocal, zonedIso } from "./zoned.ts"

const NEW_YORK = "America/New_York"
const local = (year: number, month: number, day: number, hour: number, minute: number) => ({ year, month, day, hour, minute, second: 0 })
const span = (weeks: number, days: number, hours: number, minutes: number) => ({ weeks, days, hours, minutes })

describe("zonedIso", () => {
  test("writes UTC with +00:00", () => {
    assert.equal(zonedIso(new Date("2026-11-19T09:30:00Z"), "UTC"), "2026-11-19T09:30:00+00:00")
  })

  test("writes a half-hour offset", () => {
    assert.equal(zonedIso(new Date("2026-11-19T09:30:00Z"), "Asia/Kolkata"), "2026-11-19T15:00:00+05:30")
  })

  test("writes New York's offset in winter and summer", () => {
    assert.equal(zonedIso(new Date("2026-11-19T14:00:00Z"), NEW_YORK), "2026-11-19T09:00:00-05:00")
    assert.equal(zonedIso(new Date("2026-07-01T13:00:00Z"), NEW_YORK), "2026-07-01T09:00:00-04:00")
  })
})

describe("resolveLocal", () => {
  test("a wall time that exists once is that instant", () => {
    assert.equal(zonedIso(resolveLocal(local(2026, 11, 19, 15, 0), "Asia/Kolkata"), "Asia/Kolkata"), "2026-11-19T15:00:00+05:30")
    assert.equal(zonedIso(resolveLocal(local(2026, 7, 1, 9, 0), NEW_YORK), NEW_YORK), "2026-07-01T09:00:00-04:00")
  })

  test("a time in the spring-forward gap moves forward by the gap", () => {
    assert.equal(zonedIso(resolveLocal(local(2026, 3, 8, 2, 30), NEW_YORK), NEW_YORK), "2026-03-08T03:30:00-04:00")
  })

  test("a time the clock repeats is the earlier instant", () => {
    assert.equal(zonedIso(resolveLocal(local(2026, 11, 1, 1, 30), NEW_YORK), NEW_YORK), "2026-11-01T01:30:00-04:00")
  })

  test("keeps seconds", () => {
    const time = { ...local(2026, 11, 19, 15, 0), second: 45 }

    assert.equal(zonedIso(resolveLocal(time, "UTC"), "UTC"), "2026-11-19T15:00:45+00:00")
  })
})

describe("addDuration", () => {
  const saturday = new Date("2026-03-07T09:00:00-05:00")

  test("a day is a calendar step that keeps the wall time across spring forward", () => {
    assert.equal(zonedIso(addDuration(saturday, span(0, 1, 0, 0), NEW_YORK), NEW_YORK), "2026-03-08T09:00:00-04:00")
  })

  test("24 hours is elapsed time", () => {
    assert.equal(zonedIso(addDuration(saturday, span(0, 0, 24, 0), NEW_YORK), NEW_YORK), "2026-03-08T10:00:00-04:00")
  })

  test("a week is seven calendar days", () => {
    assert.equal(zonedIso(addDuration(saturday, span(1, 0, 0, 0), NEW_YORK), NEW_YORK), "2026-03-14T09:00:00-04:00")
  })

  test("hours and minutes are elapsed across fall back", () => {
    const start = new Date("2026-11-01T00:30:00-04:00")

    assert.equal(zonedIso(addDuration(start, span(0, 0, 1, 30), NEW_YORK), NEW_YORK), "2026-11-01T01:00:00-05:00")
  })

  test("a day landing in the gap moves forward by the gap", () => {
    const start = new Date("2026-03-07T02:30:00-05:00")

    assert.equal(zonedIso(addDuration(start, span(0, 1, 0, 0), NEW_YORK), NEW_YORK), "2026-03-08T03:30:00-04:00")
  })

  test("days step first, then hours and minutes elapse", () => {
    assert.equal(zonedIso(addDuration(saturday, span(0, 1, 1, 30), NEW_YORK), NEW_YORK), "2026-03-08T10:30:00-04:00")
  })

  test("keeps milliseconds", () => {
    const start = new Date("2026-11-19T09:30:00.250Z")

    assert.equal(addDuration(start, span(0, 1, 0, 0), "UTC").toISOString(), "2026-11-20T09:30:00.250Z")
  })
})

describe("time zones", () => {
  test("an IANA name is accepted", () => {
    assert.equal(checkTimezone("Asia/Kolkata"), undefined)
  })

  test("an unknown name is refused with its reason", () => {
    assert.deepEqual(checkTimezone("Mars/Olympus"), { error: 'timezone "Mars/Olympus" is not an IANA time zone' })
  })
})
