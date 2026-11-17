import { PollSourceError, type SourcePollDeferred } from "@sourcefed/core"
import { GithubRateLimiter, githubRequestsPerMinute, type GithubApi } from "./github-limiter.ts"

const API = "https://api.github.com"
const GRAPHQL = `${API}/graphql`
const TIMEOUT_MS = 30_000
// GitHub asks for at least a minute when a limited answer names no time; the limiter
// backs off further for repeated ones.
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
  // The APIs whose first request `acquire` paid for.
  private readonly prepaid: Set<GithubApi>

  private constructor(
    private readonly token: string,
    private readonly monitorId: string,
    apis: readonly GithubApi[],
  ) {
    this.prepaid = new Set(apis)
  }

  /** A client for one poll of `monitorId`, or undefined while the poll must wait its turn. */
  static open(token: string, monitorId: string, apis: readonly GithubApi[], first = false): GithubClient | undefined {
    if (!limiter.acquire(token, monitorId, apis, first)) return undefined
    return new GithubClient(token, monitorId, apis)
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

  /**
   * A GraphQL query's data. A failed answer, or errors with no data, throw; errors beside
   * data (a nested field the token may not read) are logged once and the data is used. A
   * rate limit waits.
   */
  async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const response = await this.send("graphql", GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    })
    const body = (await response.json().catch(() => undefined)) as { data?: unknown; errors?: Array<{ type?: string; message?: string }> } | undefined
    const errors = Array.isArray(body?.errors) ? body.errors : []
    if (errors.some((error) => error?.type === "RATE_LIMITED")) {
      this.waitOut("graphql", waitSeconds(response.headers, Date.now(), () => limiter.backoff(this.token, "graphql")))
    }
    if (!response.ok) throw new PollSourceError(`GitHub GraphQL ${response.status}${errors.length ? `: ${errorText(errors)}` : ""}`)
    if (errors.length > 0 && (body?.data === null || body?.data === undefined)) throw new PollSourceError(`GitHub GraphQL: ${errorText(errors)}`)
    if (errors.length > 0) warnOnce(`[sourcefed] GitHub GraphQL answered with errors beside its data: ${errorText(errors)}`)

    return body?.data
  }

  private async send(api: GithubApi, url: string, init: RequestInit): Promise<Response> {
    if (!limiter.charge(this.token, api, this.prepaid.delete(api))) throw new GithubWaiting(api)

    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          "user-agent": "sourcefed",
          "x-github-api-version": "2022-11-28",
          ...(init.headers as Record<string, string>),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new PollSourceError(`GitHub ${api} request failed: ${message}`, { cause: error })
    }
    if (response.status === 403 || response.status === 429) {
      const detail = await response.clone().text().catch(() => "")
      const waitSec = rateLimitWait(response, detail, Date.now(), () => limiter.backoff(this.token, api))
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
  throw new PollSourceError(`GitHub ${response.status} for ${path}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
}

/**
 * Seconds to wait when a 403 or 429 is a rate limit, or undefined when it is not: a 429,
 * a 403 with no requests remaining, or a 403 naming a secondary limit (`abuse detection`
 * in older answers). `untimed` gives the wait for a limit that names no time.
 */
export function rateLimitWait(
  response: Response,
  detail: string,
  now: number,
  untimed: () => number = () => DEFAULT_WAIT_SEC,
): number | undefined {
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0"
  const limited = response.status === 429 || exhausted || /rate limit|abuse detection/i.test(detail)
  if (!limited) return undefined
  return waitSeconds(response.headers, now, untimed)
}

// Retry-After when given ("0" still waits a second), else the quota's reset when none is
// left and it is still ahead, else `untimed`. GitHub sends Retry-After in seconds; an
// HTTP-date form is deliberately not parsed and falls through. A reset at or before now
// (this clock runs ahead of GitHub's) backs off instead of looping one-second waits.
function waitSeconds(headers: Headers, now: number, untimed: () => number): number {
  const retryAfter = headers.get("retry-after")?.trim() ?? ""
  const seconds = Number(retryAfter)
  if (retryAfter !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds))

  const reset = Number(headers.get("x-ratelimit-reset") ?? "")
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset * 1000 > now) {
    return Math.max(1, Math.ceil(reset - now / 1000))
  }
  return untimed()
}

// Each distinct line once a process; bounded so a stream of different errors keeps
// little memory.
const MAX_WARNED = 100
const warned = new Set<string>()

function warnOnce(line: string): void {
  if (warned.has(line)) return
  if (warned.size >= MAX_WARNED) warned.clear()
  warned.add(line)
  console.warn(line)
}

function errorText(errors: Array<{ message?: string }>): string {
  return errors.map((error) => error?.message ?? "unknown error").join("; ").slice(0, 200)
}
