import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { parseDuration } from "./durations.ts"

const parts = (weeks: number, days: number, hours: number, minutes: number) => ({ weeks, days, hours, minutes })

describe("parseDuration", () => {
  test("reads each unit", () => {
    assert.deepEqual(parseDuration("45m", "in"), parts(0, 0, 0, 45))
    assert.deepEqual(parseDuration("2h", "in"), parts(0, 0, 2, 0))
    assert.deepEqual(parseDuration("3d", "in"), parts(0, 3, 0, 0))
    assert.deepEqual(parseDuration("2w", "every"), parts(2, 0, 0, 0))
  })

  test("combines units in the order w, d, h, m", () => {
    assert.deepEqual(parseDuration("1h30m", "in"), parts(0, 0, 1, 30))
    assert.deepEqual(parseDuration("1d12h", "every"), parts(0, 1, 12, 0))
    assert.deepEqual(parseDuration("1w2d3h4m", "in"), parts(1, 2, 3, 4))
  })

  test("refuses units out of order or repeated", () => {
    assert.deepEqual(parseDuration("30m1h", "in"), { error: 'in "30m1h" is not a duration like 45m, 1h30m or 2d' })
    assert.deepEqual(parseDuration("1h1h", "every"), { error: 'every "1h1h" is not a duration like 45m, 1h30m or 2d' })
  })

  test("refuses less than a minute", () => {
    assert.deepEqual(parseDuration("0m", "in"), { error: "in must be at least 1m" })
    assert.deepEqual(parseDuration("30s", "in"), { error: "in must be at least 1m" })
  })

  test("accepts 1m and 366d, the bounds", () => {
    assert.deepEqual(parseDuration("1m", "in"), parts(0, 0, 0, 1))
    assert.deepEqual(parseDuration("366d", "every"), parts(0, 366, 0, 0))
  })

  test("refuses more than 366 days", () => {
    assert.deepEqual(parseDuration("367d", "every"), { error: "every must be at most 366d" })
    assert.deepEqual(parseDuration("53w", "in"), { error: "in must be at most 366d" })
    assert.deepEqual(parseDuration("366d1m", "in"), { error: "in must be at most 366d" })
  })

  test("refuses anything else, naming the text", () => {
    assert.deepEqual(parseDuration("20 minutes", "in"), { error: 'in "20 minutes" is not a duration like 45m, 1h30m or 2d' })
    assert.deepEqual(parseDuration("", "every"), { error: 'every "" is not a duration like 45m, 1h30m or 2d' })
    assert.deepEqual(parseDuration("1h 30m", "in"), { error: 'in "1h 30m" is not a duration like 45m, 1h30m or 2d' })
    assert.deepEqual(parseDuration("90s", "in"), { error: 'in "90s" is not a duration like 45m, 1h30m or 2d' })
    assert.deepEqual(parseDuration("-5m", "in"), { error: 'in "-5m" is not a duration like 45m, 1h30m or 2d' })
  })
})
