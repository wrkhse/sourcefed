import { COLLECTION_LIMIT, PollSourceError, type CollectionListing } from "@sourcefed/core"
import { githubBody } from "../api/client.ts"
import type { GithubIssuesSource } from "./schema.ts"

const API = "https://api.github.com"
const PAGE_SIZE = 100
// Pull requests share the issues list, so allow pages beyond the item limit before giving up.
const MAX_PAGES = 20

export type GithubIssue = { repo: string; number: number; title: string; url: string }

export type IssueListing =
  | { status: "unchanged" }
  | { status: "listed"; listing: CollectionListing<GithubIssue>; etag?: string }

export type GithubFetch = (url: string, headers: Record<string, string>) => Promise<Response>

/**
 * Every open issue matching the source, through the issues list (with its ETag
 * when the list fits one page) or, with a `query`, the search API. Any failure
 * or incomplete result throws, so a poll never compares against a partial list.
 */
export async function listIssues(source: GithubIssuesSource, etag: string | undefined, request: GithubFetch): Promise<IssueListing> {
  if (source.query) return searchIssues(source, request)

  const issues: GithubIssue[] = []
  let url: string | undefined = issuesUrl(source)
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const conditional: Record<string, string> = page === 0 && etag ? { "if-none-match": etag } : {}
    const response = await request(url, conditional)
    if (page === 0 && response.status === 304) return { status: "unchanged" }

    const body = await githubBody(response, url)
    if (!Array.isArray(body)) throw new PollSourceError(`GitHub gave an unexpected issues list for ${source.repo}`)

    for (const item of body) {
      if (!item.pull_request) issues.push(toIssue(source.repo, item))
    }
    if (issues.length > COLLECTION_LIMIT) return { status: "listed", listing: { overLimit: true } }

    url = nextLink(response.headers.get("link"))
    if (!url) {
      const single = page === 0 ? response.headers.get("etag") ?? undefined : undefined
      return { status: "listed", listing: { overLimit: false, items: issues }, etag: single }
    }
  }
  return { status: "listed", listing: { overLimit: true } }
}

/**
 * Each named issue read directly. Only open issues are listed, so a closed issue is absent
 * like a missing or gone one: the comparison emits item.unmatched without failing the poll.
 * A rename redirect is followed once; pull requests share the endpoint and are skipped.
 */
export async function listNumberedIssues(source: GithubIssuesSource, request: GithubFetch): Promise<IssueListing> {
  const issues: GithubIssue[] = []

  for (const number of source.issueNumbers ?? []) {
    const url = `${API}/repos/${source.repo}/issues/${number}`
    let response = await request(url, {})

    if (response.status === 301 || response.status === 302) {
      const location = response.headers.get("location")
      if (!location) throw new PollSourceError(`GitHub issue ${source.repo}#${number} redirected without a location`)
      response = await request(location, {})
    }

    if (response.status === 404 || response.status === 410) continue

    const body = await githubBody(response, url)
    if (body?.state === "open" && !body.pull_request) issues.push(toIssue(source.repo, body))
  }

  return { status: "listed", listing: { overLimit: false, items: issues } }
}

async function searchIssues(source: GithubIssuesSource, request: GithubFetch): Promise<IssueListing> {
  const issues: GithubIssue[] = []
  const query = new URLSearchParams({ q: searchQuery(source), per_page: String(PAGE_SIZE), sort: "created", order: "asc" })
  let url: string | undefined = `${API}/search/issues?${query}`
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const response = await request(url, {})
    const body = await githubBody(response, url)
    if (body?.incomplete_results) throw new PollSourceError(`GitHub search gave incomplete results for ${source.repo}`)
    if (Number(body?.total_count) > COLLECTION_LIMIT) return { status: "listed", listing: { overLimit: true } }

    for (const item of body?.items ?? []) issues.push(toIssue(source.repo, item))
    url = nextLink(response.headers.get("link"))
  }
  if (url) return { status: "listed", listing: { overLimit: true } }

  return { status: "listed", listing: { overLimit: false, items: issues } }
}

function issuesUrl(source: GithubIssuesSource): string {
  const query = new URLSearchParams({ state: "open", labels: (source.labels ?? []).join(","), per_page: String(PAGE_SIZE) })
  if (source.assignee) query.set("assignee", source.assignee)
  if (source.author) query.set("creator", source.author)
  return `${API}/repos/${source.repo}/issues?${query}`
}

function searchQuery(source: GithubIssuesSource): string {
  const terms = [`repo:${source.repo}`, "is:issue", "is:open", ...(source.labels ?? []).map((label) => `label:"${label}"`)]
  if (source.assignee) terms.push(`assignee:${source.assignee}`)
  if (source.author) terms.push(`author:${source.author}`)
  if (source.query) terms.push(source.query)
  return terms.join(" ")
}

function toIssue(repo: string, item: any): GithubIssue {
  return { repo, number: Number(item.number), title: String(item.title ?? ""), url: String(item.html_url ?? "") }
}

/** The `rel="next"` URL of a GitHub `Link` header. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}
