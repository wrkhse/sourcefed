import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import { sourceDefinition } from "../registry.ts"
import { clampBytes, MAX_BLOCK_BYTES, triageEvidence } from "./evidence.ts"

const githubPullRequest: MonitorRecord["source"] = { type: "github", repo: "wrkhse/chauffeur", prNumber: 42 }

function monitorRecord(source: MonitorRecord["source"]): MonitorRecord {
  return {
    id: "monitor-1",
    name: "test monitor",
    source,
    delivery: "poll",
    target: { kind: "test", id: "session-1" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    cursors: {},
  }
}

function monitorEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    source: { type: "github" },
    kind: "review",
    at: "2026-11-17T00:00:00.000Z",
    summary: "Changes requested on PR #42",
    actionable: true,
    ...overrides,
  }
}

describe("triageEvidence", () => {
  test("a GitHub pull request keeps its thread label and monitor description", () => {
    const monitor = monitorRecord(githubPullRequest)
    const evidence = triageEvidence(monitor, monitorEvent({ body: "Please bound it." }))

    assert.equal(
      evidence.event,
      "source: github\nkind: review\nsummary: Changes requested on PR #42\nbody: Please bound it.\nactionable: yes",
    )
    assert.equal(evidence.thread, "#42")
    assert.equal(evidence.monitor, sourceDefinition(monitor.source)?.describe(monitor.source))
  })

  const issueThreads: Array<[string, string[], string, string]> = [
    ["label and title", ["atelier:build"], "  Fix the tick race ", "atelier:build: Fix the tick race"],
    ["title only", [], "  Fix the tick race ", "Fix the tick race"],
  ]

  for (const [name, labels, title, expected] of issueThreads) {
    test(`a github-issues monitor's thread is its ${name}`, () => {
      const monitor = monitorRecord({ type: "github-issues", repo: "wrkhse/atelier", labels })
      const evidence = triageEvidence(monitor, monitorEvent({
        source: monitor.source,
        kind: "item.matched",
        summary: "Issue matched",
        subject: { type: "github-issue", key: "wrkhse/atelier#12", title },
      }))

      assert.equal(evidence.thread, expected)
    })
  }

  test("a Slack thread's informational event says so and keeps an empty body", () => {
    const monitor = monitorRecord({ type: "slack", channelId: "C0LANE", threadTs: "1712345678.000100" })
    const evidence = triageEvidence(monitor, monitorEvent({
      source: monitor.source,
      kind: "reply",
      summary: "A teammate replied",
      actionable: false,
      body: undefined,
    }))

    assert.equal(evidence.thread, "thread")
    assert.deepEqual(evidence.event.split("\n"), [
      "source: slack",
      "kind: reply",
      "summary: A teammate replied",
      "body: ",
      "actionable: no (informational)",
    ])
  })

  test("an unknown source type contributes no monitor text or thread label", () => {
    const monitor = monitorRecord({ type: "telepathy" })
    const evidence = triageEvidence(monitor, monitorEvent({ source: {} }))

    assert.equal(evidence.event.split("\n")[0], "source: telepathy")
    assert.equal(evidence.monitor, "")
    assert.equal(evidence.thread, "")
  })

  test("an event without a source falls back to the monitor's source type", () => {
    const monitor = monitorRecord(githubPullRequest)
    const evidence = triageEvidence(monitor, monitorEvent({ source: undefined }))

    assert.equal(evidence.event.split("\n")[0], "source: github")
  })
})

describe("clampBytes", () => {
  test("returns text that already fits unchanged", () => {
    assert.equal(clampBytes("plain ascii"), "plain ascii")
  })

  test("clamps multibyte text to whole code points within the byte limit", () => {
    const clamped = clampBytes("é".repeat(20_000))

    assert.ok(Buffer.byteLength(clamped, "utf8") <= MAX_BLOCK_BYTES)
    assert.equal(clamped.length % 2, 0)
    assert.equal(clamped.includes("\uFFFD"), false)
  })

  test("never cuts an emoji surrogate pair in half", () => {
    const clamped = clampBytes("😀".repeat(100), 10)

    assert.equal(clamped, "😀😀")
    assert.ok(Buffer.byteLength(clamped, "utf8") <= 10)
    assert.equal(/[\uD800-\uDBFF]$/.test(clamped), false)
  })

  test("a 40 KiB event body leaves the event block within the limit", () => {
    const monitor = monitorRecord(githubPullRequest)
    const evidence = triageEvidence(monitor, monitorEvent({ body: "x".repeat(40 * 1024) }))

    assert.ok(Buffer.byteLength(evidence.event, "utf8") <= MAX_BLOCK_BYTES)
  })
})
