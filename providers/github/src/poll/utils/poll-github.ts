import * as v from "valibot"
import type { SourcePollDeferred } from "@sourcefed/core"
import { appendGithubCiEvent } from "./append-github-ci-event.ts"
import { appendGithubConflictEvent } from "./append-github-conflict-event.ts"
import { appendGithubReviews } from "./append-github-reviews.ts"
import { appendGithubStateEvent } from "./append-github-state-event.ts"
import { appendComments } from "./append-comments.ts"
import { emptyGithubCursor } from "./empty-cursor.ts"
import { DEFERRED, GithubClient, deferOnWait, fetchGithubComments, fetchPrData, githubToken, type GithubApi } from "../../api"
import { GithubCursorSchema } from "../../schema.ts"
import type { GithubCursor, GithubEvent } from "../../types"
import { pullRequestSubject } from "../../utils/pull-request-subject.ts"

// A pull request poll sends one GraphQL query and at least two REST requests.
const PR_APIS: readonly GithubApi[] = ["graphql", "rest"]

let warnedMissingToken = false

export type GithubPoll = { events: GithubEvent[]; cursor: GithubCursor; terminal: boolean }

/**
 * One poll of a pull request for `monitorId`. It waits its turn in the token's budget, and a
 * rate limit part-way through defers the whole poll, so the cursor moves only after a
 * complete read and no event is lost or sent twice.
 */
export async function pollGithub(repo: string, prNumber: number, cursorRaw: unknown, monitorId: string): Promise<GithubPoll | SourcePollDeferred> {
  const parsedCursor = v.safeParse(GithubCursorSchema, cursorRaw)
  let cursor = emptyGithubCursor()
  if (parsedCursor.success) cursor = parsedCursor.output

  const token = githubToken()
  if (!token) {
    if (!warnedMissingToken) {
      warnedMissingToken = true
      console.warn("[sourcefed] GH_TOKEN or GITHUB_TOKEN is not set; GitHub monitors will not poll")
    }
    return { events: [], cursor, terminal: false }
  }

  let historyPrimed = cursor.historyPrimed
  if (!historyPrimed) historyPrimed = Boolean(cursor.reviewIds.length || cursor.commentIds.length || cursor.ciState || cursor.mergeable || cursor.prState)
  const github = GithubClient.open(token, monitorId, PR_APIS, !historyPrimed)
  if (!github) return DEFERRED

  return deferOnWait(() => readPullRequest(github, repo, prNumber, cursor, historyPrimed))
}

async function readPullRequest(github: GithubClient, repo: string, prNumber: number, cursor: GithubCursor, historyPrimed: boolean): Promise<GithubPoll> {
  const events: GithubEvent[] = []
  const ref = `#${prNumber}`
  const data = await fetchPrData(github, repo, prNumber)
  const lineCommentsPrimed = cursor.lineCommentsPrimed
  const conversationCommentsPrimed = cursor.conversationCommentsPrimed

  appendGithubReviews(repo, prNumber, cursor, events, data.reviews ?? [], historyPrimed)
  if (!cursor.historyPrimed) cursor.historyPrimed = true

  const lineComments = await fetchGithubComments(github, `repos/${repo}/pulls/${prNumber}/comments`)
  appendComments(repo, prNumber, cursor, events, lineComments, "c:", lineCommentsPrimed,
    (comment) => `Comment by ${comment.user?.login ?? "someone"} on ${comment.path ?? ref}`,
    (comment) => {
      let location = comment.path ?? ""
      if (comment.line) location += `:${comment.line}`
      return `${location} — ${comment.body ?? ""}`
    })
  cursor.lineCommentsPrimed = true

  const conversationComments = await fetchGithubComments(github, `repos/${repo}/issues/${prNumber}/comments`)
  appendComments(repo, prNumber, cursor, events, conversationComments, "issue:", conversationCommentsPrimed,
    (comment) => `Comment by ${comment.user?.login ?? "someone"} on ${ref}`,
    (comment) => comment.body ?? "")
  cursor.conversationCommentsPrimed = true

  await appendGithubCiEvent(github, repo, prNumber, cursor, events, data.statusCheckRollup ?? [])

  const mergeable = data.mergeable ?? data.mergeStateStatus ?? "UNKNOWN"
  appendGithubConflictEvent(repo, prNumber, cursor, events, mergeable)

  const prState = data.state ?? "OPEN"
  const terminal = appendGithubStateEvent(repo, prNumber, cursor, events, prState)

  const subject = pullRequestSubject(repo, prNumber, data.title)
  for (const event of events) {
    if (!event.subject) event.subject = { ...subject }
  }

  return { events, cursor, terminal }
}
