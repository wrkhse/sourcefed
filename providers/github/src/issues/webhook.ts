import type { MonitorEvent } from "@sourcefed/core"
import { issueCommentEvent, type GithubIssueComment } from "./events.ts"

const REPO = /^[\w.-]+\/[\w.-]+$/

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/** A verified issue_comment delivery for a newly created comment on a plain issue. */
export function parseIssueCommentWebhook(payload: unknown, now: () => Date): MonitorEvent | undefined {
  const body = record(payload)
  if (!body || body.action !== "created") return undefined

  const issue = record(body.issue)
  if (!issue || issue.pull_request !== undefined) return undefined

  const repo = record(body.repository)?.full_name
  if (typeof repo !== "string" || !REPO.test(repo)) return undefined

  const number = issue.number
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined

  const comment = record(body.comment)
  if (!comment) return undefined
  const commentId = comment.id
  if (typeof commentId !== "number" || !Number.isInteger(commentId)) return undefined

  const author = record(comment.user)?.login ?? record(body.sender)?.login
  if (typeof author !== "string" || author.length === 0) return undefined

  const commentBody = comment.body
  if (typeof commentBody !== "string") return undefined

  const htmlUrl = issue.html_url
  const url = typeof htmlUrl === "string" ? htmlUrl : `https://github.com/${repo}/issues/${number}`

  const input: GithubIssueComment = { repo, number, commentId, author, body: commentBody, url }
  const title = issue.title
  if (typeof title === "string") input.title = title

  const createdAt = comment.created_at
  const at = typeof createdAt === "string" ? createdAt : now().toISOString()

  return {
    ...issueCommentEvent(input, at),
    source: { type: "github-issues", repo, issueNumbers: [number] },
  }
}
