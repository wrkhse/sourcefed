import type { SourcePollDeferred } from "@sourcefed/core"
import { GithubRateLimiter, githubRequestsPerMinute, type GithubApi } from "./github-limiter.ts"

const API = "https://api.github.com"
const GRAPHQL = `${API}/graphql`
const TIMEOUT_MS = 30_000
// GitHub asks for at least a minute when a limited answer names no time.
const DEFAULT_WAIT_SEC = 60

export const DEFERRED: SourcePollDeferred = { deferred: true }

export function githubToken(): string | undefined {
  return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
}

/** A request held back because its API waits out a rate limit on this token. */
export class GithubWaiting extends Error {
  constructor(readonly api: GithubApi) {
    super(`GitHub ${api} is waiting out a rate limit`)
  }
}

let limiter = defaultLimiter()

/** Forget every token's budget and wait, so a test starts from scratch. */
export function resetGithubApi(next: GithubRateLimiter = defaultLimiter()): void {
  limiter = next
}

function defaultLimiter(): GithubRateLimiter {
  return new GithubRateLimiter({
    requestsPerMinute: githubRequestsPerMinute(),
    now: () => Date.now(),
    log: (line) => console.warn(line),
  })
}

/**
 * One poll's requests to GitHub. Each is charged to the token's budget for its API, and a
 * rate-limited answer starts that API's wait and throws `GithubWaiting`, so the poll stops
 * without reading anything more and `deferOnWait` defers it.
 */
export class GithubClient {
  private constructor(
    private readonly token: string,
    private readonly monitorId: string,
  ) {}

  /** A client for one poll of `monitorId`, or undefined while the poll must wait its turn. */
  static open(token: string, monitorId: string, apis: readonly GithubApi[], first = false): GithubClient | undefined {
    if (!limiter.acquire(token, monitorId, apis, first)) return undefined
    return new GithubClient(token, monitorId)
  }

  /** A REST resource's JSON; any answer but a success or a rate limit throws with its status. */
  async json(path: string): Promise<unknown> {
    const url = `${API}${path}`
    return githubBody(await this.request(url), url)
  }

  /** A REST answer as GitHub gave it, unless it is a rate limit. */
  async request(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send("rest", url, { headers: { accept: "application/vnd.github+json", ...headers } })
  }

  /** A GraphQL query's data; errors and failed answers throw, and a rate limit waits. */
  async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const response = await this.send("graphql", GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    })
    const body = (await response.json().catch(() => undefined)) as { data?: unknown; errors?: Array<{ type?: string; message?: string }> } | undefined
    const errors = Array.isArray(body?.errors) ? body.errors : []
    if (errors.some((error) => error?.type === "RATE_LIMITED")) this.waitOut("graphql", waitSeconds(response.headers, Date.now()))
    if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}${errors.length ? `: ${errorText(errors)}` : ""}`)
    if (errors.length > 0) throw new Error(`GitHub GraphQL: ${errorText(errors)}`)

    return body?.data
  }

  private async send(api: GithubApi, url: string, init: RequestInit): Promise<Response> {
    if (!limiter.charge(this.token, api)) throw new GithubWaiting(api)

    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "user-agent": "sourcefed",
        "x-github-api-version": "2022-11-28",
        ...(init.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 403 || response.status === 429) {
      const detail = await response.clone().text().catch(() => "")
      const waitSec = rateLimitWait(response, detail, Date.now())
      if (waitSec !== undefined) this.waitOut(api, waitSec)
    }
    return response
  }

  private waitOut(api: GithubApi, waitSec: number): never {
    limiter.pause(this.token, api, waitSec, this.monitorId)
    throw new GithubWaiting(api)
  }
}

/** Runs one poll's reads, deferring the poll when a rate limit stops them part-way. */
export async function deferOnWait<T>(read: () => Promise<T>): Promise<T | SourcePollDeferred> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof GithubWaiting) return DEFERRED
    throw error
  }
}

/** A successful answer's JSON; anything else throws with its status and the start of its body. */
export async function githubBody(response: Response, url: string): Promise<any> {
  if (response.ok) return response.json()

  const detail = await response.text().catch(() => "")
  const path = url.replace(API, "")
  throw new Error(`GitHub ${response.status} for ${path}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
}

/**
 * Seconds to wait when a 403 or 429 is a rate limit, or undefined when it is not: a 429,
 * a 403 with no requests remaining, or a 403 naming a (secondary) rate limit.
 */
export function rateLimitWait(response: Response, detail: string, now: number): number | undefined {
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0"
  const limited = response.status === 429 || exhausted || /rate limit/i.test(detail)
  if (!limited) return undefined
  return waitSeconds(response.headers, now)
}

// Retry-After when given ("0" still waits a second), else the quota's reset when none is
// left, else a minute.
function waitSeconds(headers: Headers, now: number): number {
  const retryAfter = headers.get("retry-after")?.trim() ?? ""
  const seconds = Number(retryAfter)
  if (retryAfter !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds))

  const reset = Number(headers.get("x-ratelimit-reset") ?? "")
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil(reset - now / 1000))
  }
  return DEFAULT_WAIT_SEC
}

function errorText(errors: Array<{ message?: string }>): string {
  return errors.map((error) => error?.message ?? "unknown error").join("; ").slice(0, 200)
}
