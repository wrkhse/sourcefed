import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, mock, test } from "node:test"
import { InMemoryMonitorStore, MonitorRuntime } from "@sourcefed/core"
import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import { GithubRateLimiter, MAX_WAIT_SEC, githubRequestsPerMinute } from "./api/github-limiter.ts"
import { rateLimitWait, resetGithubApi } from "./api/client.ts"
import { GithubIssuesMonitor } from "./issues"
import { GithubMonitor } from "./monitor.ts"

// No test calls GitHub: fetch is replaced by a fake GitHub, and Date by a fake clock.
const realFetch = globalThis.fetch
const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "SOURCEFED_GITHUB_REQUESTS_PER_MINUTE"] as const
const realEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const START = Date.parse("2026-11-14T06:00:00.000Z")
const TOKEN = "ghp-test"

type Api = "rest" | "graphql"
type Call = { api: Api; path: string; pr?: number; token: string; at: number; status: number }
type Answer = "429" | "403-quota" | "403-secondary" | "graphql-200"
type Limit = { api: Api; answer: Answer; retryAfter?: number; resetInSec?: number; path?: RegExp }

class FakeGithub {
  calls: Call[] = []
  limit: Limit | undefined
  reviews = new Map<number, any[]>()
  comments = new Map<number, any[]>()
  errors: Array<[RegExp, number]> = []

  install(): void {
    globalThis.fetch = (async (input: string, init: RequestInit) => {
      const url = new URL(String(input))
      const api: Api = url.pathname === "/graphql" ? "graphql" : "rest"
      const token = String(new Headers(init.headers).get("authorization")).replace("Bearer ", "")
      const variables = api === "graphql" ? JSON.parse(String(init.body)).variables : undefined
      const call: Call = { api, path: url.pathname, pr: variables?.number, token, at: Date.now(), status: 200 }
      this.calls.push(call)

      const error = this.errors.find(([pattern]) => pattern.test(url.pathname))
      if (error) {
        call.status = error[1]
        return Response.json({ message: "Not Found" }, { status: error[1] })
      }
      const limited = this.limited(api, url.pathname)
      if (limited) {
        call.status = limited.status
        return limited
      }
      return this.answer(api, url.pathname, variables)
    }) as typeof fetch
  }

  private limited(api: Api, path: string): Response | undefined {
    const limit = this.limit
    if (!limit || limit.api !== api || (limit.path && !limit.path.test(path))) return undefined

    const headers: Record<string, string> = {}
    if (limit.retryAfter !== undefined) headers["retry-after"] = String(limit.retryAfter)
    if (limit.resetInSec !== undefined) {
      headers["x-ratelimit-remaining"] = "0"
      headers["x-ratelimit-reset"] = String(Math.floor(Date.now() / 1000) + limit.resetInSec)
    }
    if (limit.answer === "429") return Response.json({ message: "Too many requests" }, { status: 429, headers })
    if (limit.answer === "403-quota") return Response.json({ message: "API rate limit exceeded for user ID 1." }, { status: 403, headers })
    if (limit.answer === "403-secondary") {
      return Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers })
    }
    return Response.json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, { headers })
  }

  private answer(api: Api, path: string, variables: any): Response {
    if (api === "graphql") {
      const page = { hasNextPage: false, endCursor: null }
      const pullRequest = {
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviews: { nodes: this.reviews.get(variables.number) ?? [], pageInfo: page },
        statusCheckRollup: { contexts: { nodes: [], pageInfo: page } },
      }
      return Response.json({ data: { repository: { pullRequest } } })
    }

    const comments = path.match(/^\/repos\/org\/repo\/issues\/(\d+)\/comments$/)
    if (comments) return Response.json(this.comments.get(Number(comments[1])) ?? [])
    if (/^\/repos\/org\/repo\/pulls\/\d+\/comments$/.test(path)) return Response.json([])
    if (path === "/repos/org/repo/issues") return Response.json([])
    return Response.json({ message: "Not Found" }, { status: 404 })
  }

  rest(): Call[] {
    return this.calls.filter((call) => call.api === "rest")
  }

  graphql(): Call[] {
    return this.calls.filter((call) => call.api === "graphql")
  }
}

let github: FakeGithub
let shared: GithubRateLimiter
let logs: string[]
let failures: string[]

function limiter(requestsPerMinute = 30): GithubRateLimiter {
  return new GithubRateLimiter({ requestsPerMinute, now: () => Date.now(), log: (line) => logs.push(line) })
}

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.SOURCEFED_GITHUB_REQUESTS_PER_MINUTE
  process.env.GITHUB_TOKEN = TOKEN
  mock.timers.enable({ apis: ["Date"], now: START })
  logs = []
  failures = []
  // Node reports its experimental-API warnings here too, once a process.
  mock.method(console, "error", (...args: unknown[]) => {
    const line = args.map(String).join(" ")
    if (!line.includes("ExperimentalWarning")) failures.push(line)
  })
  github = new FakeGithub()
  github.install()
  shared = limiter()
  resetGithubApi(shared)
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (realEnv[key] === undefined) delete process.env[key]
    else process.env[key] = realEnv[key]
  }
  mock.timers.reset()
  mock.restoreAll()
  resetGithubApi()
})

type Setup = { runtime: MonitorRuntime; delivered: MonitorEvent[]; records: MonitorRecord[] }

function newRuntime(delivered: MonitorEvent[]): MonitorRuntime {
  return new MonitorRuntime({
    store: new InMemoryMonitorStore(),
    sink: { deliver: async ({ event }) => { delivered.push(event); return { ok: true } } },
    sources: { github: new GithubMonitor(), "github-issues": new GithubIssuesMonitor() },
    sourceForWebhookPath: () => undefined,
  })
}

async function addPr(runtime: MonitorRuntime, prNumber: number): Promise<MonitorRecord> {
  const { monitor } = await runtime.service.create({
    name: `pr ${prNumber}`,
    source: { type: "github", repo: "org/repo", prNumber },
    delivery: "poll",
    target: { kind: "test", id: `session-${prNumber}` },
    pollIntervalSec: 60,
  })
  return monitor
}

async function runtimeWith(prs: number, issueMonitors = 0): Promise<Setup> {
  const delivered: MonitorEvent[] = []
  const runtime = newRuntime(delivered)
  const records: MonitorRecord[] = []
  for (let index = 1; index <= prs; index++) records.push(await addPr(runtime, index))
  for (let index = 1; index <= issueMonitors; index++) {
    const { monitor } = await runtime.service.create({
      name: `issues ${index}`,
      source: { type: "github-issues", repo: "org/repo", labels: [`label-${index}`] },
      delivery: "poll",
      target: { kind: "test", id: `issues-${index}` },
      pollIntervalSec: 60,
    })
    records.push(monitor)
  }
  return { runtime, delivered, records }
}

async function runFor(runtime: MonitorRuntime, ms: number, everyMs = 5_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += everyMs) {
    mock.timers.tick(everyMs)
    await runtime.tick()
  }
}

// Runs until GitHub answers with `status`, and returns when it did.
async function runUntilLimited(runtime: MonitorRuntime, status: number): Promise<number> {
  for (let ticks = 0; ticks < 100; ticks++) {
    const hit = github.calls.find((call) => call.status === status)
    if (hit) return hit.at
    await runFor(runtime, 5_000)
  }
  throw new Error(`GitHub never answered ${status}`)
}

function busiestMinute(calls: Call[]): number {
  const times = calls.map((call) => call.at)
  return Math.max(...times.map((start) => times.filter((at) => at >= start && at < start + 60_000).length))
}

describe("GitHub rate limits", () => {
  test("a REST limit holds every monitor on the token until it resets, and GraphQL keeps no wait", async () => {
    const { runtime } = await runtimeWith(5)
    await runtime.tick()
    await runFor(runtime, 2 * 60_000)

    github.limit = { api: "rest", answer: "403-quota", resetInSec: 120 }
    const limitedAt = await runUntilLimited(runtime, 403)
    github.limit = undefined
    assert.ok(shared.waitsUntil(TOKEN, "rest") > Date.now(), "REST waits")
    assert.equal(shared.waitsUntil(TOKEN, "graphql"), 0, "GraphQL has no wait of its own")

    await runFor(runtime, 4 * 60_000)
    const early = github.calls.filter((call) => call.at > limitedAt && call.at < limitedAt + 120_000)
    assert.deepEqual(early, [], "no monitor polls before the reset")
    assert.ok(github.calls.some((call) => call.at >= limitedAt + 120_000), "polls resume after the reset")
    assert.deepEqual(logs, [
      "[sourcefed] GitHub REST rate-limited: waiting 120s before polling 5 GitHub monitors on this token again",
    ])
    assert.deepEqual(failures, [])
  })

  test("a GraphQL limit holds pull request monitors, not monitors that use only REST", async () => {
    const { runtime } = await runtimeWith(3, 2)
    await runtime.tick()
    await runFor(runtime, 2 * 60_000)

    github.limit = { api: "graphql", answer: "graphql-200", resetInSec: 300 }
    const limitedAt = github.graphql().length
    await runFor(runtime, 5_000)
    while (github.graphql().length === limitedAt) await runFor(runtime, 5_000)
    const hit = github.graphql().at(-1)!.at
    github.limit = undefined
    assert.equal(shared.waitsUntil(TOKEN, "rest"), 0, "REST has no wait of its own")

    await runFor(runtime, 6 * 60_000)
    const during = github.calls.filter((call) => call.at > hit && call.at < hit + 300_000)
    assert.deepEqual(during.filter((call) => call.api === "graphql"), [], "no GraphQL query during the wait")
    assert.deepEqual(during.filter((call) => call.path.includes("/comments")), [], "pull request polls are deferred whole")
    assert.ok(during.filter((call) => call.path === "/repos/org/repo/issues").length >= 8, "issue monitors keep polling")
    assert.deepEqual(logs, [
      "[sourcefed] GitHub GraphQL rate-limited: waiting 300s before polling 3 GitHub monitors on this token again",
    ])
    assert.deepEqual(failures, [])
  })

  test("a limit part-way through a poll keeps the cursor, and each event is delivered once", async () => {
    const { runtime, delivered, records } = await runtimeWith(1)
    await runtime.tick()
    await runFor(runtime, 70_000)
    const before = (await runtime.service.get(records[0]!.id))!.cursors

    github.reviews.set(1, [{ databaseId: 7, author: { login: "alice" }, state: "COMMENTED", submittedAt: "2026-11-14T06:01:00Z", body: "Please rename it" }])
    github.comments.set(1, [{ id: 101, user: { login: "bob" }, body: "Looks good", created_at: "2026-11-14T06:01:10Z" }])
    github.limit = { api: "rest", answer: "429", retryAfter: 30, path: /\/issues\/1\/comments$/ }
    await runUntilLimited(runtime, 429)
    github.limit = undefined

    const during = (await runtime.service.get(records[0]!.id))!.cursors
    assert.deepEqual(during, before, "the deferred poll changed nothing")
    assert.equal(delivered.length, 0)

    await runFor(runtime, 5 * 60_000)
    assert.deepEqual(delivered.map((event) => event.summary).sort(), [
      "Comment by bob on #1",
      "Review by alice [COMMENTED] on #1",
    ])
    assert.match(logs[0]!, /GitHub REST rate-limited: waiting 30s before polling 1 GitHub monitor on/)
  })

  test("the log counts every monitor on the token, however their polls are spread", async () => {
    const delivered: MonitorEvent[] = []
    const runtime = newRuntime(delivered)
    for (let index = 1; index <= 12; index++) {
      await addPr(runtime, index)
      await runFor(runtime, 5_000)
    }
    await runFor(runtime, 3 * 60_000)
    const lastMinute = github.graphql().filter((call) => call.at > Date.now() - 60_000)
    assert.ok(new Set(lastMinute.map((call) => call.at)).size >= 6, "polls are spread over the minute")

    github.limit = { api: "rest", answer: "429", retryAfter: 30 }
    await runUntilLimited(runtime, 429)
    github.limit = undefined
    await runFor(runtime, 60_000)
    assert.deepEqual(logs, [
      "[sourcefed] GitHub REST rate-limited: waiting 30s before polling 12 GitHub monitors on this token again",
    ])
  })

  test("25 monitors on one token stay within its budget", async () => {
    const { runtime } = await runtimeWith(25)
    await runtime.tick()
    await runFor(runtime, 30 * 60_000)

    const burst = shared.burst
    // A poll is admitted with one request's credit and sends two REST requests.
    const overdraw = 1
    const rest = github.rest()
    assert.ok(busiestMinute(rest) <= 30 + burst + overdraw, `busiest REST minute had ${busiestMinute(rest)}`)
    assert.ok(rest.length <= 30 * 30 + burst + overdraw, `${rest.length} REST requests in 30 minutes`)
    assert.ok(rest.length >= 29 * 30, `the budget is used: ${rest.length} REST requests`)
    assert.ok(busiestMinute(github.graphql()) <= 30 + burst, "GraphQL stays within its budget")

    const perPr = [...Array(25).keys()].map((index) => github.graphql().filter((call) => call.pr === index + 1).length)
    assert.ok(Math.min(...perPr) >= 15, `every monitor polls in turn: ${perPr.join(",")}`)
    assert.deepEqual(logs, [])
  })

  test("a 404 or a failed GraphQL answer is a poll failure, not a wait", async () => {
    github.errors = [[/\/pulls\/1\/comments$/, 404]]
    const { runtime, records } = await runtimeWith(1)
    await runtime.tick()
    assert.equal(failures.length, 1)
    assert.match(failures[0]!, /GitHub 404 for \/repos\/org\/repo\/pulls\/1\/comments/)
    assert.equal((await runtime.service.get(records[0]!.id))!.cursors.__lastPolledAt, undefined)

    // A failed poll is tried again after its interval.
    github.errors = [[/^\/graphql$/, 502]]
    await runFor(runtime, 65_000)
    assert.match(failures.at(-1)!, /GitHub GraphQL 502/)
    assert.deepEqual(logs, [])
  })

  test("an unprimed monitor whose polls keep failing waits its turn after its first", async () => {
    const { runtime } = await runtimeWith(40)
    await runtime.tick()
    await runFor(runtime, 3 * 60_000)

    github.errors = [[/\/pulls\/99\/comments$/, 404]]
    const createdAt = Date.now()
    await addPr(runtime, 99)
    await runFor(runtime, 5 * 60_000)

    const polls = github.graphql().filter((call) => call.pr === 99)
    assert.ok(polls[0]!.at - createdAt <= 10_000, "its first poll goes ahead")
    // The queue of 41 monitors turns about every 160 seconds at 15 polls a minute.
    assert.ok(polls.length <= 4, `${polls.length} polls in five minutes`)
    assert.ok(failures.length > 0 && failures.every((line) => line.includes("GitHub 404")))
  })
})

describe("GitHub rate-limit answers and budget", () => {
  test("which answers are rate limits, and how long each waits", () => {
    const now = START
    const reset = String(START / 1000 + 90)
    const cases: Array<[string, number, Record<string, string>, string, number | undefined]> = [
      ["429 without headers", 429, {}, "", 60],
      ["429 with Retry-After", 429, { "retry-after": "20" }, "", 20],
      ["Retry-After 0", 429, { "retry-after": "0" }, "", 1],
      ["403 with no requests left", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "API rate limit exceeded", 90],
      ["403 secondary limit", 403, { "retry-after": "45" }, "You have exceeded a secondary rate limit", 45],
      ["403 secondary limit without Retry-After", 403, {}, "You have exceeded a secondary rate limit", 60],
      ["403 not a limit", 403, { "x-ratelimit-remaining": "4000" }, "Resource not accessible by integration", undefined],
    ]
    for (const [name, status, headers, message, expected] of cases) {
      const response = new Response(JSON.stringify({ message }), { status, headers })
      assert.equal(rateLimitWait(response, JSON.stringify({ message }), now), expected, name)
    }
  })

  test("SOURCEFED_GITHUB_REQUESTS_PER_MINUTE values", () => {
    const cases: Array<[string | undefined, number, boolean]> = [
      [undefined, 30, false],
      ["", 30, false],
      ["1", 1, false],
      ["75", 75, false],
      ["76", 75, true],
      ["0", 30, true],
      ["-3", 30, true],
      ["fast", 30, true],
    ]
    for (const [value, expected, warns] of cases) {
      const warnings: string[] = []
      assert.equal(githubRequestsPerMinute(value, (line) => warnings.push(line)), expected, `value ${JSON.stringify(value)}`)
      assert.equal(warnings.length, warns ? 1 : 0, `warnings for ${JSON.stringify(value)}`)
    }
  })

  test("no budget lets an hour start more than GitHub's 5000 requests", () => {
    for (let perMinute = 1; perMinute <= 75; perMinute++) {
      const { burst } = limiter(perMinute)
      assert.ok(perMinute * 60 + burst <= 5000, `${perMinute} a minute has a burst of ${burst}`)
    }
  })

  test("a first poll jumps the queue only until it is granted", () => {
    const apis = ["rest"] as const
    for (const key of ["m1", "m2", "m3", "m4"]) {
      assert.equal(shared.acquire(TOKEN, key, apis), true)
      shared.charge(TOKEN, "rest")
    }
    assert.equal(shared.acquire(TOKEN, "m5", apis), false)
    assert.equal(shared.acquire(TOKEN, "m6", apis), false)

    mock.timers.tick(2_000)
    assert.equal(shared.acquire(TOKEN, "new", apis, true), true, "a new monitor goes ahead of m5 and m6")
    shared.charge(TOKEN, "rest")
    mock.timers.tick(2_000)
    assert.equal(shared.acquire(TOKEN, "new", apis, true), false, "its next poll, still unprimed, waits its turn")
    assert.equal(shared.acquire(TOKEN, "m5", apis), true)
  })

  test("a wait longer than an hour is capped and says so", () => {
    shared.acquire(TOKEN, "m1", ["rest"])
    shared.pause(TOKEN, "rest", 7200, "m1")
    mock.timers.tick(5_000)
    assert.equal(shared.acquire(TOKEN, "m1", ["rest"]), false)
    assert.deepEqual(logs, [
      `[sourcefed] GitHub REST rate-limited: waiting 3600s (GitHub asked for 7200s; waits are capped at ${MAX_WAIT_SEC}s) before polling 1 GitHub monitor on this token again`,
    ])
  })
})
