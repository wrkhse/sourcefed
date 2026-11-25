import type { SourceEvent } from "@sourcefed/core";
import type { GithubIssue } from "./api.ts";
import type { GithubIssuesSource } from "./schema.ts";

export function issueKey(issue: GithubIssue): string {
  return `${issue.repo}#${issue.number}`;
}

export type GithubIssueComment = {
  repo: string;
  number: number;
  commentId: number;
  author: string;
  body: string;
  url: string;
  title?: string;
};

export function issueCommentEvent(
  comment: GithubIssueComment,
  at: string,
): SourceEvent {
  const key = `${comment.repo}#${comment.number}`;
  return {
    kind: "issue.comment",
    id: `issue.comment:${key}:${comment.commentId}`,
    at,
    summary: `New comment by ${comment.author} on GitHub issue ${key}`,
    body: comment.body,
    actionable: true,
    subject: {
      type: "github-issue",
      key,
      repo: comment.repo,
      number: comment.number,
      url: comment.url,
      commentId: comment.commentId,
      author: comment.author,
      ...(comment.title !== undefined ? { title: comment.title } : {}),
    },
  };
}

export function matchedEvent(
  source: GithubIssuesSource,
  issue: GithubIssue,
  at: string,
): SourceEvent {
  const key = issueKey(issue);
  return {
    kind: "item.matched",
    id: `item.matched:${key}:${at}`,
    at,
    summary: `GitHub issue ${key} matches ${filterText(source)}: ${issue.title}`,
    body: issue.url,
    actionable: true,
    subject: {
      type: "github-issue",
      key,
      repo: issue.repo,
      number: issue.number,
      url: issue.url,
      title: issue.title,
    },
  };
}

export function unmatchedEvent(
  source: GithubIssuesSource,
  key: string,
  at: string,
): SourceEvent {
  const number = Number(key.slice(key.lastIndexOf("#") + 1));
  const url = `https://github.com/${source.repo}/issues/${number}`;
  return {
    kind: "item.unmatched",
    id: `item.unmatched:${key}:${at}`,
    at,
    summary: `GitHub issue ${key} no longer matches ${filterText(source)}`,
    body: url,
    actionable: false,
    subject: { type: "github-issue", key, repo: source.repo, number, url },
  };
}

export function limitEvent(
  source: GithubIssuesSource,
  limit: number,
  at: string,
): SourceEvent {
  return {
    kind: "error",
    id: `error:limit:${at}`,
    at,
    summary: `More than ${limit.toLocaleString("en")} GitHub issues in ${source.repo} match ${filterText(source)}; matching pauses until fewer match`,
    body: "Narrow the labels, assignee, author or query. Nothing is reported unmatched while the limit is passed.",
    actionable: true,
  };
}

export function filterText(source: GithubIssuesSource): string {
  if (source.issueNumbers)
    return `issues ${source.issueNumbers.map((number) => `#${number}`).join(", ")}`;

  const labels = source.labels ?? [];
  const parts = [
    `${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`,
  ];
  if (source.assignee) parts.push(`assignee ${source.assignee}`);
  if (source.author) parts.push(`author ${source.author}`);
  if (source.query) parts.push(`"${source.query}"`);
  return parts.join(", ");
}
