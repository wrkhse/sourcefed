import { mergeCursors, toMonitorEvent } from "@sourcefed/core";
import type { MonitorCreateInput, SourceInput } from "@sourcefed/core";
import { defineSource, type SourceDefinition } from "@sourcefed/sdk";
import type { GithubSourceRecord } from "./types";
import { GithubCursorSchema, GithubSourceSchema } from "./schema.ts";
import { pollGithub } from "./poll";
import { parseGithubWebhook, verifyGithubWebhook } from "./webhook";
import { parseIssueCommentWebhook } from "./issues/webhook.ts";
import { updateGithubCursor } from "./webhook/utils/update-github-cursor.ts";
import { htmlToMarkdown } from "./utils/html-to-markdown.ts";

/** A pull request as data, plus the poll and webhook the host drives with its own http and clock. */
export const githubSource: SourceDefinition<GithubSourceRecord> = {
  type: "github",
  schema: GithubSourceSchema,
  cursor: GithubCursorSchema,
  input: {
    description:
      "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
    properties: {
      repo: {
        type: "string",
        description: "GitHub owner/name, e.g. owner/repository",
      },
      prNumber: {
        type: "integer",
        minimum: 1,
        description: "Pull request number",
      },
    },
    required: ["repo", "prNumber"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (input.repo && input.prNumber)
      return { type: "github", repo: input.repo, prNumber: input.prNumber };
    return { error: "repo and prNumber are required for a github monitor" };
  },
  key: (source) => `github:${source.repo}#${source.prNumber}`,
  label: (source) => `#${source.prNumber}`,
  detail: (source) => ` ${source.repo}#${source.prNumber}`,
  describe: (source) => `GitHub ${source.repo}#${source.prNumber}`,
  icon: "󰊤",
  // A delivery may write the cursor while a poll runs, so the poll merges into it.
  mergeCursor: mergeCursors,
  poll: async ({ source, cursor, monitorId, http, now }) => {
    const result = await pollGithub(
      http,
      now,
      source.repo,
      source.prNumber,
      cursor,
      monitorId,
    );
    if ("deferred" in result) return result;

    return {
      cursor: result.cursor,
      events: result.events.map((event) => {
        const monitorEvent = toMonitorEvent(event, source);
        return { ...monitorEvent, body: htmlToMarkdown(monitorEvent.body) };
      }),
      terminal: result.terminal,
    };
  },
  webhook: {
    path: "/webhooks/github",
    preferred: true,
    configured: () => Boolean(process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET),
    verify: (body, request) => verifyGithubWebhook(body, request),
    deliveryId: (request: Request) =>
      request.headers.get("x-github-delivery") ?? undefined,
    eventName: (request: Request) =>
      request.headers.get("x-github-event") ?? "github",
    // Plain-issue comments belong to github-issues watches; PR comments keep the PR parser.
    parse: (payload, eventName, deliveryId, now) => {
      const body = payload as { issue?: { pull_request?: unknown } } | null;
      const plainIssueComment =
        eventName === "issue_comment" &&
        typeof payload === "object" &&
        payload !== null &&
        body?.issue?.pull_request === undefined;
      if (plainIssueComment) return parseIssueCommentWebhook(payload, now);
      return parseGithubWebhook(payload, eventName, deliveryId, now);
    },
    updateCursor: updateGithubCursor,
  },
};

/** The monitor the daemon registers. */
export const GithubMonitor = defineSource(githubSource);
