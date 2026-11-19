import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { JsonMonitorStore, type MonitorRecord } from "@sourcefed/core"
import { githubIssuesSource, githubSource } from "@sourcefed/provider-github"
import { jiraQuerySource, jiraSource } from "@sourcefed/provider-jira"
import { scheduleSource } from "@sourcefed/provider-schedule"
import { slackSource } from "@sourcefed/provider-slack"
import { timerSource } from "@sourcefed/provider-timer"
import { yabSource } from "@sourcefed/provider-yab"
import type { GoldenFixture } from "@sourcefed/sdk"
import * as v from "valibot"
import { GITHUB_GOLDEN } from "../../../providers/github/src/fixtures/golden.ts"
import { GITHUB_ISSUES_GOLDEN } from "../../../providers/github/src/issues/fixtures/golden.ts"
import { JIRA_GOLDEN } from "../../../providers/jira/src/fixtures/golden.ts"
import { JIRA_QUERY_GOLDEN } from "../../../providers/jira/src/query/fixtures/golden.ts"
import { SCHEDULE_GOLDEN } from "../../../providers/schedule/src/fixtures/golden.ts"
import { SLACK_GOLDEN } from "../../../providers/slack/src/fixtures/golden.ts"
import { YAB_GOLDEN } from "../../../providers/yab/src/fixtures/golden.ts"
import { SOURCE_MAP, SOURCE_TYPES } from "./registry.ts"

// The pre-SDK tree's own recordings, so the audit reads what that code wrote and never the live state.
const FIXTURES: readonly GoldenFixture[] = [
  JIRA_GOLDEN,
  JIRA_QUERY_GOLDEN,
  GITHUB_GOLDEN,
  GITHUB_ISSUES_GOLDEN,
  SLACK_GOLDEN,
  YAB_GOLDEN,
  SCHEDULE_GOLDEN,
]

const CURSORS: Readonly<Record<string, v.GenericSchema<unknown>>> = {
  jira: jiraSource.cursor,
  "jira-query": jiraQuerySource.cursor,
  github: githubSource.cursor,
  "github-issues": githubIssuesSource.cursor,
  slack: slackSource.cursor,
  yab: yabSource.cursor,
  schedule: scheduleSource.cursor,
  timer: timerSource.cursor,
}

// The timer is new with the SDK, so no pre-SDK recording exists: a one-shot and an interval as the
// daemon stores them stand in for one.
const TIMER_RECORDS: readonly { id: string; source: unknown; key: string; cursor: unknown }[] = [
  {
    id: "audit-timer-once",
    source: { type: "timer", job: "check the deploy", due: "2026-11-19T15:20:00+05:30", timezone: "Asia/Kolkata" },
    key: "timer:check the deploy:2026-11-19T15:20:00+05:30",
    cursor: { checkedAt: "2026-11-19T09:40:00.000Z" },
  },
  {
    id: "audit-timer-every",
    source: { type: "timer", job: "stretch", every: "45m", anchor: "2026-11-19T15:00:00+05:30", timezone: "Asia/Kolkata" },
    key: "timer:stretch:45m:2026-11-19T15:00:00+05:30",
    cursor: { checkedAt: "2026-11-19T10:15:00.000Z" },
  },
]

const STAMP = "2026-11-18T00:00:00.000Z"
const LAST_POLLED_AT = 1_763_424_000_000

let stateDir: string | undefined

after(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
})

/** One monitor as the pre-SDK daemon stored it: the last cursor a fixture's poll wrote, under its recorded key. */
function auditRecord(fixture: GoldenFixture): { record: MonitorRecord; key: string } {
  const polled = fixture.cases.filter((kase) => kase.cursorAfter !== undefined && kase.cursorAfter !== null)
  const last = polled.at(-1)
  if (!last) assert.fail(`${fixture.provider}: no poll case wrote a cursor`)

  const record: MonitorRecord = {
    id: `audit-${fixture.provider}`,
    name: fixture.provider,
    // A fixture records the source as plain JSON; the store's own schema checks it on load.
    source: last.source as MonitorRecord["source"],
    delivery: "poll",
    target: { kind: "audit", id: "audit" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    cursors: { [last.key]: last.cursorAfter, __lastPolledAt: LAST_POLLED_AT, __routedEventIds: [] },
  }

  return { record, key: last.key }
}

function timerRecord(timer: (typeof TIMER_RECORDS)[number]): { record: MonitorRecord; key: string } {
  const record: MonitorRecord = {
    id: timer.id,
    name: timer.id,
    source: timer.source as MonitorRecord["source"],
    delivery: "poll",
    target: { kind: "audit", id: "audit" },
    pollIntervalSec: 15,
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    cursors: { [timer.key]: timer.cursor, __lastPolledAt: LAST_POLLED_AT, __routedEventIds: [] },
  }

  return { record, key: timer.key }
}

test("every record in a copy of monitors.json keeps its key and its cursor validates", async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "sourcefed-audit-"))
  const audited = [...FIXTURES.map(auditRecord), ...TIMER_RECORDS.map(timerRecord)]
  const keys = new Map(audited.map(({ record, key }) => [record.id, key]))

  await new JsonMonitorStore({ stateDir }).save({ monitors: audited.map(({ record }) => record) })

  // A fresh store reads the file back, so the audit covers the file format and not the objects in memory.
  const { monitors } = await new JsonMonitorStore({ stateDir }).load()

  assert.deepEqual([...new Set(monitors.map((record) => record.source.type))].sort(), [...SOURCE_TYPES].sort(), "the audit covers every source type")

  for (const record of monitors) {
    const type = record.source.type
    const monitor = SOURCE_MAP[type as keyof typeof SOURCE_MAP]
    const source = monitor.validateSource(record.source)
    const key = monitor.key(source as never)
    const cursor = record.cursors[key]

    assert.equal(key, keys.get(record.id), `${type}: key`)
    assert.notEqual(cursor, undefined, `${type}: cursor under its key`)
    assert.ok(v.safeParse(CURSORS[type], cursor).success, `${type}: cursor shape`)
  }
})
