import * as v from "valibot"
import { CollectionCursorSchema } from "@sourcefed/core"

export const ISSUE_NUMBER_ERROR = "issueNumbers must be positive integers, at most 100, without duplicates"
export const ISSUE_NUMBER_FILTERS_ERROR = "assignee, author and query do not apply with issueNumbers"

export const GithubIssuesSourceSchema = v.object({
  type: v.literal("github-issues"),
  repo: v.string(),
  labels: v.optional(v.array(v.string())),
  issueNumbers: v.optional(
    v.pipe(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
      v.maxLength(100),
      v.check((numbers) => new Set(numbers).size === numbers.length, ISSUE_NUMBER_ERROR),
    ),
  ),
  assignee: v.optional(v.string()),
  author: v.optional(v.string()),
  query: v.optional(v.string()),
  includeExisting: v.optional(v.boolean()),
})

export type GithubIssuesSource = v.InferOutput<typeof GithubIssuesSourceSchema>

export const GithubIssuesCursorSchema = v.object({
  ...CollectionCursorSchema.entries,
  etag: v.optional(v.string()),
})

export type GithubIssuesCursor = v.InferOutput<typeof GithubIssuesCursorSchema>
