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
}

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

test("every record in a copy of monitors.json keeps its key and its cursor validates", async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "sourcefed-audit-"))
  const audited = FIXTURES.map(auditRecord)
  const keys = new Map(audited.map(({ record, key }) => [record.id, key]))

  await new JsonMonitorStore({ stateDir }).save({ monitors: audited.map(({ record }) => record) })

  // A fresh store reads the file back, so the audit covers the file format and not the objects in memory.
  const { monitors } = await new JsonMonitorStore({ stateDir }).load()

  assert.deepEqual(monitors.map((record) => record.source.type).sort(), [...SOURCE_TYPES].sort(), "the audit covers every source type")

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
