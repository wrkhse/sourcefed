import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isPollSourceError } from "@sourcefed/core"
import { pollTimer } from "./poll.ts"
import type { TimerInterval, TimerOneShot } from "./schema.ts"

const timezone = "Asia/Kolkata"
const job = "check the deploy"
const key = "timer:check the deploy:2026-11-19T15:20:00+05:30"
const oneShot: TimerOneShot = { type: "timer", job, due: "2026-11-19T15:20:00+05:30", timezone }
const stretch: TimerInterval = { type: "timer", job: "stretch", every: "45m", anchor: "2026-11-19T09:00:00+05:30", timezone }
const stretchKey = "timer:stretch:45m:2026-11-19T09:00:00+05:30"

describe("pollTimer, one-shot", () => {
  test("before due nothing fires", () => {
    const now = new Date("2026-11-19T15:19:00+05:30")

    assert.deepEqual(pollTimer(oneShot, null, now), { cursor: { checkedAt: now.toISOString() }, events: [], terminal: false })
  })

  test("just after due it fires on time and ends", () => {
    const now = new Date("2026-11-19T15:20:30+05:30")

    assert.deepEqual(pollTimer(oneShot, null, now), {
      cursor: { checkedAt: now.toISOString() },
      events: [{
        kind: "timer.fired",
        id: `timer.fired:${key}:2026-11-19T15:20:00+05:30`,
        at: "2026-11-19T15:20:00+05:30",
        summary: "Timer check the deploy fired at 2026-11-19T15:20:00+05:30",
        actionable: true,
        subject: { type: "timer", key: job, job, at: "2026-11-19T15:20:00+05:30", timezone },
      }],
      terminal: true,
    })
  })

  test("three hours after due it fires late and ends", () => {
    const result = pollTimer(oneShot, null, new Date("2026-11-19T18:20:00+05:30"))

    assert.equal(result.terminal, true)
    assert.deepEqual(result.events, [{
      kind: "timer.fired",
      id: `timer.fired:${key}:2026-11-19T15:20:00+05:30`,
      at: "2026-11-19T15:20:00+05:30",
      summary: "Timer check the deploy fired at 2026-11-19T15:20:00+05:30, 3h late",
      actionable: true,
      subject: { type: "timer", key: job, job, at: "2026-11-19T15:20:00+05:30", timezone, late: true, lateSec: 3 * 3600 },
    }])
  })

  test("a late delay keeps its two largest units", () => {
    const result = pollTimer(oneShot, null, new Date("2026-11-19T18:40:00+05:30"))

    assert.equal(result.events[0]?.summary, "Timer check the deploy fired at 2026-11-19T15:20:00+05:30, 3h 20m late")
  })

  test("a past at fires once on the first poll and ends", () => {
    const past: TimerOneShot = { type: "timer", job, due: "2026-11-17T13:00:00+05:30", timezone }

    const result = pollTimer(past, null, new Date("2026-11-19T17:30:00+05:30"))

    assert.equal(result.terminal, true)
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]?.summary, "Timer check the deploy fired at 2026-11-17T13:00:00+05:30, 2d 4h late")
  })
})

describe("pollTimer, interval", () => {
  test("the first poll before the first firing finds nothing", () => {
    const now = new Date("2026-11-19T09:10:00+05:30")

    assert.deepEqual(pollTimer(stretch, null, now), { cursor: { checkedAt: now.toISOString() }, events: [], terminal: false })
  })

  test("a firing found on time is timer.fired", () => {
    const result = pollTimer(stretch, { checkedAt: "2026-11-19T04:14:45.000Z" }, new Date("2026-11-19T09:45:10+05:30"))

    assert.equal(result.terminal, false)
    assert.deepEqual(result.events, [{
      kind: "timer.fired",
      id: `timer.fired:${stretchKey}:2026-11-19T09:45:00+05:30`,
      at: "2026-11-19T09:45:00+05:30",
      summary: "Timer stretch fired at 2026-11-19T09:45:00+05:30",
      actionable: true,
      subject: { type: "timer", key: "stretch", job: "stretch", at: "2026-11-19T09:45:00+05:30", timezone, every: "45m" },
    }])
  })

  test("a gap of five periods is one timer.missed", () => {
    const result = pollTimer(stretch, { checkedAt: "2026-11-19T09:10:00+05:30" }, new Date("2026-11-19T12:50:00+05:30"))

    assert.deepEqual(result.events, [{
      kind: "timer.missed",
      id: `timer.missed:${stretchKey}:2026-11-19T12:45:00+05:30`,
      at: "2026-11-19T12:45:00+05:30",
      summary: "Timer stretch missed 5 times; the latest was 2026-11-19T12:45:00+05:30",
      body: "Sourcefed was not running, or the Mac was asleep, when these times came. This one event stands for all of them.",
      actionable: true,
      subject: { type: "timer", key: "stretch", job: "stretch", at: "2026-11-19T12:45:00+05:30", timezone, every: "45m", missed: 5 },
    }])
  })

  test("a stored every that does not parse is a poll failure", () => {
    const broken: TimerInterval = { ...stretch, every: "45x" }

    assert.throws(
      () => pollTimer(broken, null, new Date("2026-11-19T10:35:00+05:30")),
      (error: unknown) => isPollSourceError(error) && error.message === 'timer every "45x" in the stored source does not parse',
    )
  })

  test("an invalid cursor reads the window from the anchor", () => {
    const result = pollTimer(stretch, { checkedAt: 7 }, new Date("2026-11-19T10:35:00+05:30"))

    assert.equal(result.events[0]?.summary, "Timer stretch missed 2 times; the latest was 2026-11-19T10:30:00+05:30")
  })

  test("polling twice from the same cursor and clock gives the same event id", () => {
    const cursor = { checkedAt: "2026-11-19T09:10:00+05:30" }
    const now = new Date("2026-11-19T12:50:00+05:30")

    assert.equal(pollTimer(stretch, cursor, now).events[0]?.id, pollTimer(stretch, cursor, now).events[0]?.id)
  })

  test("after a sleep, one missed and then the next firing keeps its phase", () => {
    const awake = pollTimer(stretch, null, new Date("2026-11-19T09:10:00+05:30"))
    const woke = pollTimer(stretch, awake.cursor, new Date("2026-11-19T12:50:00+05:30"))
    const next = pollTimer(stretch, woke.cursor, new Date("2026-11-19T13:30:30+05:30"))

    assert.deepEqual(awake.events, [])
    assert.deepEqual(woke.events.map((event) => [event.kind, event.subject?.missed]), [["timer.missed", 5]])
    assert.deepEqual(next.events.map((event) => [event.kind, event.at]), [["timer.fired", "2026-11-19T13:30:00+05:30"]])
  })
})
