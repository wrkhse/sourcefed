// GitHub limits a token to 5000 REST requests an hour and, separately, 5000 GraphQL points
// an hour (a pull request query costs one). Every use of the account shares those, so the
// monitors on a token take 30 a minute of each by default: 1800 an hour, about a third.
const DEFAULT_REQUESTS_PER_MINUTE = 30
// At 75 a minute the burst is 8. With the most one poll can overdraw, no hour starts more
// than 4500 + 8 + 23 of the 5000 requests.
export const MAX_REQUESTS_PER_MINUTE = 75
export const HOURLY_LIMIT = 5000
// The most requests one pull request poll sends on one API: REST is two comment lists of
// up to ten pages and three job logs; GraphQL is a query with up to two more review pages
// and four more check pages, read twice when a check fails.
export const MAX_REQUESTS_PER_POLL = 23

// The burst holds one runtime tick's credit (the default tick is 5s) plus one, and at
// least three, so a token polled every tick uses its whole budget.
const BURST_WINDOW_SEC = 5
const MIN_BURST = 3

// A waiter must also be silent this long before it is dropped, so ticks that overlap drop
// nobody.
const MIN_WAITER_SILENCE_MS = 15_000
// A monitor that has not asked for this long is forgotten, which bounds the memory kept.
const WAITER_FORGET_MS = 10 * 60_000

// A primary limit resets within the hour; a longer wait means a skewed clock or an odd
// answer, so waits are capped at an hour.
export const MAX_WAIT_SEC = 60 * 60

// A limit that names no time waits a minute, and twice as long as the last one when it
// comes within this long of the last such wait ending, as GitHub asks of repeated
// secondary limits.
const BACKOFF_START_SEC = 60
const BACKOFF_RESET_MS = 10 * 60_000

export type GithubApi = "rest" | "graphql"

const API_NAMES: Record<GithubApi, string> = { rest: "REST", graphql: "GraphQL" }

export type GithubLimiterOptions = {
  requestsPerMinute: number
  now: () => number
  log: (line: string) => void
}

// `apis` are the APIs the monitor's polls use. `granted` is set at its first grant; a
// first read jumps the queue only before that.
type Waiter = { lastAsked: number; seq: number; granted: boolean; apis: readonly GithubApi[] }

// One rate-limit wait on one API. Its line is written when the monitor that hit the limit
// asks again (a whole tick later) or the wait ends.
type Wait = { startedAt: number; askedSec: number; first: string; logged: boolean }

type ApiBudget = { credit: number; refilledAt: number; pausedUntil: number; wait?: Wait; backoffSec: number }

type TokenBudget = {
  apis: Record<GithubApi, ApiBudget>
  queue: string[]
  waiters: Map<string, Waiter>
  seq: number
}

/**
 * Shares GitHub request budgets between every monitor polling with the same token: one for
 * REST and one for GraphQL, each refilling at `requestsPerMinute`, each with its own
 * rate-limit wait.
 *
 * A poll is admitted when it is next in line among the monitors no wait holds back, and
 * every API it uses has a request's credit, which it takes for its first request on each.
 * Each further request is charged as it is sent, so a poll of several requests leaves the
 * budget short and later polls wait until it is paid back.
 */
export class GithubRateLimiter {
  private readonly budgets = new Map<string, TokenBudget>()
  readonly burst: number

  constructor(private readonly options: GithubLimiterOptions) {
    const perTick = Math.ceil((options.requestsPerMinute * BURST_WINDOW_SEC) / 60)
    this.burst = Math.max(1, Math.min(Math.ceil(options.requestsPerMinute), Math.max(MIN_BURST, perTick + 1)))
  }

  /**
   * Admits one poll for `key` (one monitor) that uses `apis`; false defers it. A `first`
   * poll primes a new monitor, and everything before it counts as seen, so it goes to the
   * head of the queue until the monitor's first grant.
   */
  acquire(token: string, key: string, apis: readonly GithubApi[], first = false): boolean {
    const now = this.options.now()
    const budget = this.budget(token, now)
    this.ask(budget, key, now, apis, first)

    let held = false
    for (const api of apis) {
      if (this.waiting(budget, api, key, now)) held = true
    }
    if (held) return false

    for (const api of [...apis, ...otherApis(apis)]) this.refill(budget.apis[api], now)
    if (this.nextInLine(budget, now, apis) !== key) return false
    if (apis.some((api) => budget.apis[api].credit < 1)) return false

    for (const api of apis) budget.apis[api].credit -= 1
    budget.queue = budget.queue.filter((waiting) => waiting !== key)
    budget.waiters.get(key)!.granted = true
    return true
  }

  /**
   * Charges one request on `api`, which may leave its credit below zero; a `prepaid` request
   * was paid for by `acquire`. False while the API waits.
   */
  charge(token: string, api: GithubApi, prepaid = false): boolean {
    const now = this.options.now()
    const state = this.budget(token, now).apis[api]
    if (now < state.pausedUntil) return false
    if (prepaid) return true

    this.refill(state, now)
    state.credit -= 1
    return true
  }

  /**
   * Seconds to wait for a limit that names no time: a minute, doubled for each one that
   * comes soon after the last such wait ended, at most an hour.
   */
  backoff(token: string, api: GithubApi): number {
    const now = this.options.now()
    const state = this.budget(token, now).apis[api]
    const repeated = state.backoffSec > 0 && now - state.pausedUntil < BACKOFF_RESET_MS
    state.backoffSec = repeated ? Math.min(state.backoffSec * 2, MAX_WAIT_SEC) : BACKOFF_START_SEC
    return state.backoffSec
  }

  /** Holds every monitor using `api` on `token` for `waitSec`, at most an hour. */
  pause(token: string, api: GithubApi, waitSec: number, key: string): void {
    const now = this.options.now()
    const budget = this.budget(token, now)
    const state = budget.apis[api]
    const until = now + Math.min(waitSec, MAX_WAIT_SEC) * 1000
    if (until <= state.pausedUntil) return

    if (now >= state.pausedUntil || !state.wait) {
      this.finishWait(budget, api)
      state.wait = { startedAt: now, askedSec: waitSec, first: key, logged: false }
    } else if (!state.wait.logged) {
      const elapsedSec = Math.ceil((now - state.wait.startedAt) / 1000)
      state.wait.askedSec = Math.max(state.wait.askedSec, elapsedSec + waitSec)
    }
    state.pausedUntil = until
    state.credit = 0
    state.refilledAt = until
  }

  /** When `api` on `token` may send again; 0 when it is not waiting. */
  waitsUntil(token: string, api: GithubApi): number {
    const state = this.budgets.get(token)?.apis[api]
    if (!state || this.options.now() >= state.pausedUntil) return 0
    return state.pausedUntil
  }

  private budget(token: string, now: number): TokenBudget {
    let budget = this.budgets.get(token)
    if (!budget) {
      const fresh = (): ApiBudget => ({ credit: this.burst, refilledAt: now, pausedUntil: 0, backoffSec: 0 })
      budget = { apis: { rest: fresh(), graphql: fresh() }, queue: [], waiters: new Map(), seq: 0 }
      this.budgets.set(token, budget)
    }
    return budget
  }

  // The first queued monitor that could go now. A monitor held by an API's wait, or short
  // of credit on an API the asking monitor does not use, keeps its place but does not stop
  // monitors that use only the other API.
  private nextInLine(budget: TokenBudget, now: number, asking: readonly GithubApi[]): string | undefined {
    return budget.queue.find((key) => {
      const apis = budget.waiters.get(key)?.apis ?? []
      return apis.every((api) => {
        const state = budget.apis[api]
        return now >= state.pausedUntil && (asking.includes(api) || state.credit >= 1)
      })
    })
  }

  // True while `api` waits out a rate limit. Logs the wait once the monitor that hit the
  // limit asks again, or when the wait is over.
  private waiting(budget: TokenBudget, api: GithubApi, key: string, now: number): boolean {
    const state = budget.apis[api]
    if (now >= state.pausedUntil) {
      this.finishWait(budget, api)
      return false
    }

    if (state.wait && !state.wait.logged && key === state.wait.first) this.logWait(budget, api, state.wait)
    return true
  }

  private finishWait(budget: TokenBudget, api: GithubApi): void {
    const state = budget.apis[api]
    if (state.wait && !state.wait.logged) this.logWait(budget, api, state.wait)
    state.wait = undefined
  }

  private logWait(budget: TokenBudget, api: GithubApi, wait: Wait): void {
    wait.logged = true
    const seconds = Math.round((budget.apis[api].pausedUntil - wait.startedAt) / 1000)
    const capped = seconds < wait.askedSec ? ` (GitHub asked for ${wait.askedSec}s; waits are capped at ${MAX_WAIT_SEC}s)` : ""
    // Every monitor using the API that asked recently is held back, whichever tick it asks on.
    const held = [...budget.waiters.values()].filter((waiter) => waiter.apis.includes(api)).length
    const monitors = `${held} GitHub monitor${held === 1 ? "" : "s"}`
    this.options.log(`[sourcefed] GitHub ${API_NAMES[api]} rate-limited: waiting ${seconds}s${capped} before polling ${monitors} on this token again`)
  }

  // Every due monitor asks once per runtime tick, in the same order. A waiter that has not
  // asked since this key last asked missed a whole tick, so it stopped (removed, disabled,
  // or moved to a webhook) and must not hold the queue.
  private ask(budget: TokenBudget, key: string, now: number, apis: readonly GithubApi[], first: boolean): void {
    const previous = budget.waiters.get(key)
    budget.seq += 1
    budget.waiters.set(key, { lastAsked: now, seq: budget.seq, granted: previous?.granted ?? false, apis })
    if (previous) {
      budget.queue = budget.queue.filter((waiting) => {
        const waiter = budget.waiters.get(waiting)
        if (!waiter) return false
        return waiter.seq > previous.seq || now - waiter.lastAsked < MIN_WAITER_SILENCE_MS
      })
    }
    for (const [waiting, waiter] of budget.waiters) {
      if (now - waiter.lastAsked > WAITER_FORGET_MS) budget.waiters.delete(waiting)
    }

    if (first && !previous?.granted) {
      budget.queue = [key, ...budget.queue.filter((waiting) => waiting !== key)]
    } else if (!budget.queue.includes(key)) {
      budget.queue.push(key)
    }
  }

  private refill(state: ApiBudget, now: number): void {
    if (now <= state.refilledAt) return
    const earned = ((now - state.refilledAt) / 60_000) * this.options.requestsPerMinute
    state.credit = Math.min(this.burst, state.credit + earned)
    state.refilledAt = now
  }
}

function otherApis(apis: readonly GithubApi[]): GithubApi[] {
  return (["rest", "graphql"] as const).filter((api) => !apis.includes(api))
}

/**
 * Reads SOURCEFED_GITHUB_REQUESTS_PER_MINUTE: 30 a minute of each API when unset, and at
 * most 75. An invalid or too-high value is reported through `warn` and replaced.
 */
export function githubRequestsPerMinute(
  value = process.env.SOURCEFED_GITHUB_REQUESTS_PER_MINUTE,
  warn: (line: string) => void = (line) => console.warn(line),
): number {
  if (value === undefined || value.trim() === "") return DEFAULT_REQUESTS_PER_MINUTE

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`[sourcefed] SOURCEFED_GITHUB_REQUESTS_PER_MINUTE=${JSON.stringify(value)} is not a positive number; using ${DEFAULT_REQUESTS_PER_MINUTE}`)
    return DEFAULT_REQUESTS_PER_MINUTE
  }
  if (parsed > MAX_REQUESTS_PER_MINUTE) {
    warn(`[sourcefed] SOURCEFED_GITHUB_REQUESTS_PER_MINUTE=${value} leaves no room for the burst under GitHub's ${HOURLY_LIMIT} an hour; using ${MAX_REQUESTS_PER_MINUTE}`)
    return MAX_REQUESTS_PER_MINUTE
  }
  return parsed
}
