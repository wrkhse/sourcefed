import { PollSourceError, toMonitorEvent, type MonitorCreateInput, type SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { DEFERRED, GithubClient, deferOnWait, githubToken } from "../api/client.ts"
import { filterText } from "./events.ts"
import { pollGithubIssues } from "./poll.ts"
import { GithubIssuesSourceSchema, type GithubIssuesSource } from "./schema.ts"

const REPO = /^[\w.-]+\/[\w.-]+$/

/** A labelled issue collection as data, plus the poll the host drives with its own http and clock. */
export const githubIssuesSource: SourceDefinition<GithubIssuesSource> = {
  type: "github-issues",
  schema: GithubIssuesSourceSchema,
  wake: {
    path: "/webhooks/github",
    matches: (source: GithubIssuesSource, payload: unknown, eventName: string): boolean => {
      const repo = (payload as { repository?: { full_name?: unknown } })?.repository?.full_name
      return eventName === "issues" && typeof repo === "string" && repo.toLowerCase() === source.repo.toLowerCase()
    },
  },
  input: {
    description: "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
    properties: {
      repo: { type: "string", description: "GitHub owner/name, e.g. owner/repository" },
      labels: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Labels an issue must all carry" },
      assignee: { type: "string", description: "Only issues assigned to this login" },
      author: { type: "string", description: "Only issues opened by this login" },
      query: { type: "string", description: "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API" },
      includeExisting: { type: "boolean", description: "Send item.matched for every issue already matching on the first poll" },
    },
    required: ["repo", "labels"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (!input.repo || !REPO.test(input.repo)) return { error: "repo must be owner/name for a github-issues monitor" }

    const labels = [...new Set((input.labels ?? []).map((label) => label.trim()).filter(Boolean))].sort()
    if (labels.length === 0) return { error: "labels is required for a github-issues monitor" }

    const source: GithubIssuesSource = { type: "github-issues", repo: input.repo, labels }
    if (input.assignee) source.assignee = input.assignee
    if (input.author) source.author = input.author
    if (input.query) source.query = input.query
    if (input.includeExisting) source.includeExisting = true
    return source
  },
  key: (source) =>
    `github-issues:${source.repo}:${source.labels.join(",")}:${source.assignee ?? ""}:${source.author ?? ""}:${source.query ?? ""}`,
  label: (source) => source.labels.join(", "),
  detail: (source) => ` ${source.repo} · ${filterText(source)}`,
  describe: (source) => `GitHub issues in ${source.repo} with ${filterText(source)}`,
  icon: "󰊤",
  poll: async ({ source, cursor, monitorId, http, now }) => {
    const token = githubToken()
    if (!token) throw new PollSourceError("GH_TOKEN or GITHUB_TOKEN is required for github-issues monitors")

    // An issues poll sends only REST requests, so a GraphQL wait does not hold it.
    const github = GithubClient.open(token, monitorId, ["rest"], cursor === undefined, http)
    if (!github) return DEFERRED

    const result = await deferOnWait(() => pollGithubIssues(source, cursor, (url, headers) => github.request(url, headers), now))
    if ("deferred" in result) return result

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: false,
    }
  },
}

/** The monitor the daemon registers. */
export const GithubIssuesMonitor = defineSource(githubIssuesSource)
