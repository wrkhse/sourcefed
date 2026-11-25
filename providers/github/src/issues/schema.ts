import * as v from "valibot";
import {
  CollectionCursorSchema,
  ISSUE_NUMBER_ERROR,
  orderedIssueNumbers,
} from "@sourcefed/core";

export const ISSUE_NUMBER_FILTERS_ERROR =
  "assignee, author and query do not apply with issueNumbers";

const SELECTOR_ERROR =
  "give either labels or issueNumbers for a github-issues monitor";

export const GithubIssuesSourceSchema = v.pipe(
  v.object({
    type: v.literal("github-issues"),
    repo: v.string(),
    labels: v.optional(v.pipe(v.array(v.string()), v.minLength(1))),
    issueNumbers: v.optional(
      v.pipe(
        v.array(v.number()),
        v.minLength(1),
        v.check(
          (numbers) => orderedIssueNumbers(numbers) !== undefined,
          ISSUE_NUMBER_ERROR,
        ),
      ),
    ),
    assignee: v.optional(v.string()),
    author: v.optional(v.string()),
    query: v.optional(v.string()),
    includeExisting: v.optional(v.boolean()),
  }),
  v.check(
    (source) =>
      (source.labels !== undefined) !== (source.issueNumbers !== undefined),
    SELECTOR_ERROR,
  ),
);

export type GithubIssuesSource = v.InferOutput<typeof GithubIssuesSourceSchema>;

export const GithubIssuesCursorSchema = v.object({
  ...CollectionCursorSchema.entries,
  etag: v.optional(v.string()),
});

export type GithubIssuesCursor = v.InferOutput<typeof GithubIssuesCursorSchema>;
