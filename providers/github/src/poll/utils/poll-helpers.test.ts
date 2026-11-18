import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { fetchHttp } from "@sourcefed/sdk"
import * as v from "valibot"
import { GithubClient, resetGithubApi } from "../../api"
import { appendGithubCiEvent } from "./append-github-ci-event.ts"
import { appendGithubConflictEvent } from "./append-github-conflict-event.ts"
import { appendGithubReviews } from "./append-github-reviews.ts"
import { appendGithubStateEvent } from "./append-github-state-event.ts"
import { emptyGithubCursor } from "./empty-cursor.ts"
import { GithubCursorSchema } from "../../schema.ts"
import { updateGithubCursor } from "../../webhook/utils/update-github-cursor.ts"
import type { GithubEvent } from "../../types"

// The poll's instant; a review or event with no time of its own is stamped with it.
const AT = "2026-11-18T12:00:00.000Z"

describe("GitHub poll event helpers", () => {
  test("accepts cursors written before newer fields existed", () => {
    const parsed = v.safeParse(GithubCursorSchema, {
      reviewIds: [],
      commentIds: [],
      ciState: "success",
      mergeable: "MERGEABLE",
      prState: "OPEN",
    })
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.output.historyPrimed, false)
      assert.equal(parsed.output.conversationCommentsPrimed, false)
      assert.equal(parsed.output.ciFailureState, "")
    }
  })

  test("adds reviews only after history is primed", () => {
    const cursor = emptyGithubCursor()
    const events: GithubEvent[] = []
    appendGithubReviews("org/repo", 12, cursor, events, [{ id: 1, state: "COMMENTED", body: "Please fix" }], false, AT)
    assert.equal(events.length, 0)
    appendGithubReviews("org/repo", 12, cursor, events, [{ id: 2, state: "CHANGES_REQUESTED", body: "Fix" }], true, AT)
    assert.equal(events.length, 1)
    assert.equal(events[0].actionable, true)
    assert.equal(events[0].at, AT)
  })

  test("tracks CI, conflict, and merged state transitions", async () => {
    const cursor = emptyGithubCursor()
    const events: GithubEvent[] = []
    resetGithubApi()
    const github = GithubClient.open("test-token", "m1", ["graphql", "rest"], false, fetchHttp(), () => new Date())!
    // Green checks need no request; any call to GitHub fails the test.
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => assert.fail("no request to GitHub")
    try {
      await appendGithubCiEvent(github, "org/repo", 12, cursor, events, [{ name: "Lint", conclusion: "success" }], AT)
    } finally {
      globalThis.fetch = realFetch
    }
    appendGithubConflictEvent("org/repo", 12, cursor, events, "MERGEABLE", AT)
    appendGithubConflictEvent("org/repo", 12, cursor, events, "CONFLICTING", AT)
    appendGithubStateEvent("org/repo", 12, cursor, events, "OPEN", AT)
    appendGithubStateEvent("org/repo", 12, cursor, events, "MERGED", AT)
    assert.deepEqual(events.map((event) => event.kind), ["conflict", "merged"])
    assert.equal(events.at(-1)?.terminal, true)
    assert.deepEqual(events.map((event) => event.at), [AT, AT])
  })

  test("closed PRs are terminal and emit a close event", () => {
    const cursor = emptyGithubCursor()
    const events: GithubEvent[] = []
    appendGithubStateEvent("org/repo", 12, cursor, events, "OPEN", AT)
    const terminal = appendGithubStateEvent("org/repo", 12, cursor, events, "CLOSED", AT)
    assert.equal(terminal, true)
    assert.equal(events.at(-1)?.summary, "PR #12 was CLOSED without merging")
    assert.equal(events.at(-1)?.terminal, true)
  })

  test("reconciles webhook review and comment IDs into the poll cursor", () => {
    const cursor = updateGithubCursor({
      source: { type: "github", repo: "org/repo", prNumber: 12 },
      kind: "comment",
      id: "c:42",
      at: "2026-08-04T12:00:00.000Z",
      summary: "comment",
      actionable: true,
    }, { reviewIds: [], commentIds: [], ciState: "", mergeable: "", prState: "" })
    assert.deepEqual(cursor.commentIds, ["c:42"])
    assert.equal(cursor.historyPrimed, false)
  })
})
