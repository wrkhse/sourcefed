import * as v from "valibot"

/** A timer that fires once, at `due`: an ISO instant written with the zone's offset. */
export const TimerOneShotSchema = v.object({
  type: v.literal("timer"),
  job: v.string(),
  due: v.string(),
  timezone: v.string(),
})

/** A timer that fires each `every` from `anchor`, its creation instant, written with the zone's offset. */
export const TimerIntervalSchema = v.object({
  type: v.literal("timer"),
  job: v.string(),
  every: v.string(),
  anchor: v.string(),
  timezone: v.string(),
})

export const TimerSourceSchema = v.union([TimerOneShotSchema, TimerIntervalSchema])

export type TimerOneShot = v.InferOutput<typeof TimerOneShotSchema>
export type TimerInterval = v.InferOutput<typeof TimerIntervalSchema>
export type TimerSource = v.InferOutput<typeof TimerSourceSchema>

/** The instant up to which firings have been considered. */
export const TimerCursorSchema = v.object({
  checkedAt: v.string(),
})

export type TimerCursor = v.InferOutput<typeof TimerCursorSchema>

/** The create input a timer reads: `job` and exactly one of `in`, `at` or `every`. */
export type TimerCreateInput = {
  job?: string
  in?: string
  at?: string
  every?: string
  timezone?: string
}
