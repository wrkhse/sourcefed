import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { describe, test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import { triageEvidence, type TriageEvidence } from "./evidence.ts"

type ReplayParams = {
  sessionID: string
  monitorID: string
  source: string
  kind: string
  summary: string
  body?: string
  actionable: boolean
}

type ReplayCase = {
  id: string
  monitor_source: MonitorRecord["source"]
  subject?: { title?: string }
  v1: { method: string; params: ReplayParams }
  expected: { deliver: boolean }
  evidence: TriageEvidence
}

type EventsFixture = { description: string; cases: ReplayCase[] }

type V1Fixture = {
  recorded_at: string
  daemon: { version: string }
  adapter: string
  replies: Record<string, { params: ReplayParams; deliver: boolean; reply: { effects: unknown[] }; elapsed_ms: number }>
}

const AT = "2026-11-17T00:00:00.000Z"

// The compiled test runs from packages/daemon/dist-tests/triage, so the JSON
// fixtures are found by walking up to the daemon's package.json, which sits
// beside src/, rather than by a path relative to this source file.
function fixturesDirectory(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))

  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(directory, "package.json"))) {
      return path.join(directory, "src", "triage", "fixtures")
    }

    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  throw new Error("no package.json above the replay test")
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDirectory(), name), "utf8")) as T
}

const fixture = readFixture<EventsFixture>("sourcefed-events.json")
const v1 = readFixture<V1Fixture>("sourcefed-events.v1.json")

function replayMonitor(replayCase: ReplayCase): MonitorRecord {
  return {
    id: "replay",
    name: `replay ${replayCase.id}`,
    source: replayCase.monitor_source,
    delivery: "poll",
    target: { kind: "replay", id: "replay" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    cursors: {},
  }
}

function replayEvent(replayCase: ReplayCase): MonitorEvent {
  const params = replayCase.v1.params
  const event: MonitorEvent = {
    source: { type: params.source },
    kind: params.kind,
    at: AT,
    summary: params.summary,
    body: params.body,
    actionable: params.actionable,
  }

  if (replayCase.subject) {
    event.subject = { type: "replay", key: replayCase.id, ...replayCase.subject }
  }

  return event
}

describe("sourcefed event replay", () => {
  test("the fixture holds twelve cases with unique ids", () => {
    assert.equal(fixture.cases.length, 12)
    assert.equal(new Set(fixture.cases.map((replayCase) => replayCase.id)).size, 12)
  })

  for (const replayCase of fixture.cases) {
    test(`${replayCase.id} makes the evidence recorded with its v1 reply`, () => {
      const reply = v1.replies[replayCase.id]

      assert.ok(reply, `${replayCase.id} has no v1 reply`)
      assert.deepEqual(reply.params, replayCase.v1.params, replayCase.id)
      assert.equal(reply.deliver, replayCase.expected.deliver, replayCase.id)

      const evidence = triageEvidence(replayMonitor(replayCase), replayEvent(replayCase))
      assert.deepEqual(evidence, replayCase.evidence, replayCase.id)
    })
  }
})
