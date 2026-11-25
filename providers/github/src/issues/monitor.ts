import {
  ISSUE_NUMBER_ERROR,
  PollSourceError,
  orderedIssueNumbers,
  toMonitorEvent,
  type MonitorCreateInput,
  type MonitorEvent,
  type SourceInput,
} from "@sourcefed/core";
import { defineSource, type SourceDefinition } from "@sourcefed/sdk";
import {
  DEFERRED,
  GithubClient,
  deferOnWait,
  githubToken,
} from "../api/client.ts";
import { verifyGithubWebhook } from "../webhook";
import { filterText } from "./events.ts";
import { pollGithubIssues } from "./poll.ts";
import {
  GithubIssuesCursorSchema,
  GithubIssuesSourceSchema,
  ISSUE_NUMBER_FILTERS_ERROR,
  type GithubIssuesSource,
} from "./schema.ts";
import { parseIssueCommentWebhook } from "./webhook.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;

function applyFilters(
  source: GithubIssuesSource,
  input: MonitorCreateInput,
): void {
  if (input.assignee) source.assignee = input.assignee;
  if (input.author) source.author = input.author;
  if (input.query) source.query = input.query;
  if (input.includeExisting) source.includeExisting = true;
}

/** A labelled issue collection as data, plus the poll the host drives with its own http and clock. */
export const githubIssuesSource: SourceDefinition<GithubIssuesSource> = {
  type: "github-issues",
  schema: GithubIssuesSourceSchema,
  cursor: GithubIssuesCursorSchema,
  wake: {
    path: "/webhooks/github",
    matches: (
      source: GithubIssuesSource,
      payload: unknown,
      eventName: string,
    ): boolean => {
      const body = payload as {
        repository?: { full_name?: unknown };
        issue?: { number?: unknown };
      };
      const repo = body?.repository?.full_name;
      if (
        eventName !== "issues" ||
        typeof repo !== "string" ||
        repo.toLowerCase() !== source.repo.toLowerCase()
      )
        return false;
      if (!source.issueNumbers) return true;

      return (
        typeof body?.issue?.number === "number" &&
        source.issueNumbers.includes(body.issue.number)
      );
    },
  },
  webhook: {
    path: "/webhooks/github",
    // Polling stays the primary transport even when the webhook is configured.
    preferred: false,
    configured: () => Boolean(process.env.SOURCEFED_GITHUB_WEBHOOK_SECRET),
    verify: (body, request) => verifyGithubWebhook(body, request),
    deliveryId: (request: Request) =>
      request.headers.get("x-github-delivery") ?? undefined,
    eventName: (request: Request) =>
      request.headers.get("x-github-event") ?? "github",
    parse: (payload, _eventName, _deliveryId, now) =>
      parseIssueCommentWebhook(payload, now),
    matches: (source: unknown, event: MonitorEvent): boolean => {
      const watched = source as GithubIssuesSource;
      if (event.kind !== "issue.comment") return false;
      const eventSource = event.source as
        { type?: unknown; repo?: unknown } | undefined;
      if (
        !eventSource ||
        eventSource.type !== "github-issues" ||
        typeof eventSource.repo !== "string"
      )
        return false;
      if (
        typeof watched.repo !== "string" ||
        eventSource.repo.toLowerCase() !== watched.repo.toLowerCase()
      )
        return false;
      if (!watched.issueNumbers) return false;
      return (
        typeof event.subject?.number === "number" &&
        watched.issueNumbers.includes(event.subject.number)
      );
    },
  },
  input: {
    description:
      "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops; comments on watched issues are delivered as issue.comment",
    properties: {
      repo: {
        type: "string",
        description: "GitHub owner/name, e.g. owner/repository",
      },
      labels: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "Labels an issue must all carry",
      },
      issueNumbers: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 100,
        description: "Watch only these issue numbers, e.g. [56]",
      },
      assignee: {
        type: "string",
        description: "Only issues assigned to this login",
      },
      author: {
        type: "string",
        description: "Only issues opened by this login",
      },
      query: {
        type: "string",
        description:
          "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API",
      },
      includeExisting: {
        type: "boolean",
        description:
          "Send item.matched for every issue already matching on the first poll",
      },
    },
    required: ["repo"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (!input.repo || !REPO.test(input.repo))
      return { error: "repo must be owner/name for a github-issues monitor" };

    const hasLabels = input.labels !== undefined;
    const labels = [
      ...new Set(
        (input.labels ?? []).map((label) => label.trim()).filter(Boolean),
      ),
    ].sort();

    if (hasLabels && input.issueNumbers !== undefined) {
      return {
        error:
          "give either labels or issueNumbers for a github-issues monitor, not both",
      };
    }

    if (input.issueNumbers !== undefined) {
      const numbers = orderedIssueNumbers(input.issueNumbers);
      if (!numbers) return { error: ISSUE_NUMBER_ERROR };
      if (input.assignee || input.author || input.query)
        return { error: ISSUE_NUMBER_FILTERS_ERROR };

      const numbered: GithubIssuesSource = {
        type: "github-issues",
        repo: input.repo,
        issueNumbers: numbers,
      };
      applyFilters(numbered, input);
      return numbered;
    }

    if (labels.length === 0) {
      return {
        error: hasLabels
          ? "labels is required for a github-issues monitor"
          : "give labels or issueNumbers for a github-issues monitor",
      };
    }

    const source: GithubIssuesSource = {
      type: "github-issues",
      repo: input.repo,
      labels,
    };
    applyFilters(source, input);
    return source;
  },
  key: (source) =>
    source.issueNumbers
      ? `github-issues:${source.repo}:numbers:${source.issueNumbers.join(",")}`
      : `github-issues:${source.repo}:${source.labels?.join(",") ?? ""}:${source.assignee ?? ""}:${source.author ?? ""}:${source.query ?? ""}`,
  label: (source) =>
    source.issueNumbers
      ? source.issueNumbers.map((number) => `#${number}`).join(", ")
      : (source.labels?.join(", ") ?? ""),
  detail: (source) => ` ${source.repo} · ${filterText(source)}`,
  describe: (source) =>
    `GitHub issues in ${source.repo} with ${filterText(source)}`,
  icon: "󰊤",
  poll: async ({ source, cursor, monitorId, http, now }) => {
    const token = githubToken();
    if (!token)
      throw new PollSourceError(
        "GH_TOKEN or GITHUB_TOKEN is required for github-issues monitors",
      );

    // An issues poll sends only REST requests, so a GraphQL wait does not hold it.
    const github = GithubClient.open(
      token,
      monitorId,
      ["rest"],
      cursor === undefined,
      http,
      now,
    );
    if (!github) return DEFERRED;

    const result = await deferOnWait(() =>
      pollGithubIssues(
        source,
        cursor,
        (url, headers) => github.request(url, headers),
        now,
      ),
    );
    if ("deferred" in result) return result;

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: false,
    };
  },
};

/** The monitor the daemon registers. */
export const GithubIssuesMonitor = defineSource(githubIssuesSource);
