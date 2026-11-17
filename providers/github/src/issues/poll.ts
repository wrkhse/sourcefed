import * as v from "valibot"
import { COLLECTION_LIMIT, PollMonitor, PollSourceError, compareCollection, toMonitorEvent, type SourceEvent } from "@sourcefed/core"
import { DEFERRED, GithubClient, deferOnWait, githubToken } from "../api/client.ts"
import { listIssues, type GithubFetch } from "./api.ts"
import { issueKey, limitEvent, matchedEvent, unmatchedEvent } from "./events.ts"
import { GithubIssuesCursorSchema, type GithubIssuesCursor, type GithubIssuesSource } from "./schema.ts"

export type GithubIssuesPoll = { cursor: unknown; events: SourceEvent[] }

/** One poll: list the matching issues and compare their keys with the cursor's. */
export async function pollGithubIssues(
  source: GithubIssuesSource,
  cursorRaw: unknown,
  request: GithubFetch,
  now: () => Date = () => new Date(),
): Promise<GithubIssuesPoll> {
  const parsed = v.safeParse(GithubIssuesCursorSchema, cursorRaw)
  const etag = parsed.success ? parsed.output.etag : undefined

  const result = await listIssues(source, etag, request)
  if (result.status === "unchanged") return { cursor: cursorRaw, events: [] }

  const changes = compareCollection(cursorRaw, result.listing, issueKey, source.includeExisting ?? false)
  const at = now().toISOString()
  const events = [
    ...changes.unmatched.map((key) => unmatchedEvent(source, key, at)),
    ...changes.matched.map((issue) => matchedEvent(source, issue, at)),
  ]
  if (changes.reachedLimit) events.push(limitEvent(source, COLLECTION_LIMIT, at))

  const cursor: GithubIssuesCursor = { ...changes.cursor }
  if (result.etag) cursor.etag = result.etag
  return { cursor, events }
}

export const githubIssuesPollMonitor = new PollMonitor<GithubIssuesSource>({
  run: async (source, cursor, monitorId) => {
    const token = githubToken()
    if (!token) throw new PollSourceError("GH_TOKEN or GITHUB_TOKEN is required for github-issues monitors")

    // An issues poll sends only REST requests, so a GraphQL wait does not hold it.
    const github = GithubClient.open(token, monitorId, ["rest"], cursor === undefined)
    if (!github) return DEFERRED

    const result = await deferOnWait(() => pollGithubIssues(source, cursor, (url, headers) => github.request(url, headers)))
    if ("deferred" in result) return result

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: false,
    }
  },
})
