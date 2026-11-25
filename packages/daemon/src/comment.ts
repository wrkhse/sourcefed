import { githubToken, postIssueComment } from "@sourcefed/provider-github";
import type { CommentIssueInput, CommentIssueResult } from "./types";

/** Posts a GitHub issue comment with the token the daemon already holds. */
export async function commentOnIssue(
  input: CommentIssueInput,
): Promise<CommentIssueResult> {
  const token = githubToken();
  if (!token)
    throw new Error(
      "GH_TOKEN or GITHUB_TOKEN is required to comment on a GitHub issue",
    );
  const { id, html_url } = await postIssueComment(
    globalThis.fetch,
    token,
    input.repo,
    input.issueNumber,
    input.body,
  );
  return { id, url: html_url };
}
