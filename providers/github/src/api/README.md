# GitHub API

The GitHub source calls GitHub's REST and GraphQL APIs directly with `GH_TOKEN` or
`GITHUB_TOKEN`. Every request of a poll goes through one `GithubClient`, which charges
the token's budget and turns a rate-limited answer into a wait.

| Module              | Does                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `client.ts`         | `GithubClient`: one poll's requests; `deferOnWait`; `rateLimitWait` reads a limited answer                        |
| `github-limiter.ts` | `GithubRateLimiter`: a REST and a GraphQL budget per token, served in turn, each with its own wait                |
| `pr.ts`             | `fetchPrData`: a pull request's state, reviews and checks (up to 300 and 500), in one GraphQL query and its pages |
| `comments.ts`       | `fetchGithubComments`: a REST comment list, up to ten pages                                                       |
| `logs.ts`           | `fetchJobLog`: a failed Actions job's log, at most 10 MB                                                          |

## Rate limits

GitHub gives a token 5000 REST requests an hour and, separately, 5000 GraphQL points an
hour; a pull request query is assumed to cost one point (GitHub's cost rules; not measured). The account's other use (`gh`, scripts, CI)
shares both, so every monitor on one token shares a budget of 30 requests a minute of
each API by default (`SOURCEFED_GITHUB_REQUESTS_PER_MINUTE`, read when the daemon starts).

| Setting               | Effect                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset                 | 30 a minute of each API: 1800 an hour, about a third of the quota                                                                                         |
| above 75              | capped at 75 with a warning: a burst of 8 polls can be admitted at once and each can overdraw by 22, so no hour starts more than 4500 + 8 + 8 × 22 = 4684 |
| not a positive number | 30, with a warning                                                                                                                                        |

```mermaid
flowchart LR
  tick[runtime tick] --> due{monitor due?}
  due -- yes --> open{"GithubClient.open:<br/>its turn, credit on each API?"}
  open -- no --> deferred[deferred: cursor and stamps unchanged, due again next tick]
  open -- yes --> send[send requests, each charged]
  send -- "429, 403 limit, RATE_LIMITED" --> pause[that API waits for every monitor] --> deferred
  send -- "404, 401, 5xx" --> failed[poll failure with the status]
  send -- ok --> read[parse against the cursor, deliver events]
```

- A poll is admitted when it is next in line and every API it uses has a request's
  credit, which it takes for its first request on each, so polls of overlapping ticks
  cannot share one credit. A pull request poll uses both APIs, a `github-issues` poll
  only REST. A monitor held by a wait, or short of credit on an API the asking monitor
  does not use, keeps its place without holding back monitors of the other API.
- Each further request is charged as it is sent, and may leave the credit below zero;
  later polls wait until it is paid back. A pull request poll sends one GraphQL query and
  two REST requests, more for pages and a CI failure (a second query and up to three job
  logs): at most 23 on one API.
- A rate limit is a 429, a 403 with `x-ratelimit-remaining: 0`, or a 403 naming a rate
  limit or `abuse detection`, or a GraphQL `RATE_LIMITED` error. The API waits for
  `Retry-After`, else until `x-ratelimit-reset` when no requests are left, else a
  minute, doubled for each such limit within ten minutes of the last one ending; at most
  an hour.
- A wait part-way through a poll defers the whole poll: nothing it read is kept, so the
  cursor moves only after a complete read, and no event is lost or sent twice.
- A wait is logged once, when the monitor that hit the limit asks again (a tick later) or
  the wait ends. The line names the API, the wait, and every monitor using that API that
  asked in the last ten minutes.
- A new monitor's first poll goes to the head of the queue, since it primes the cursor;
  only until its first grant, so a monitor whose polls keep failing then waits its turn.
- The burst holds one 5-second tick's credit plus one, and at least three.
- A missing job log (logs expire) only shortens a CI event; any other failed answer is a
  poll failure naming the status. GraphQL errors beside data (a nested field the token
  may not read) are logged once and the data is used; errors with no data fail the poll.

### Known limits

- Waits use the host's clock, which is the wall clock in the daemon, and live in memory, and a daemon restart forgets them. A
  step back is clamped: no wait or refill lies more than an hour ahead.
- A quota reset is read against this machine's clock, so a skewed clock waits too short
  (GitHub answers again, and the wait starts over) or too long (at most an hour). A reset
  at or before now backs off like a limit that names no time.
- `Retry-After` is read in seconds, as GitHub sends it; an HTTP-date form is not parsed.
- Polls admitted together can each overdraw by their further requests, so a busy minute
  can go over the budget by a burst of polls' worth.
- An unprimed monitor asking less often than every ten minutes regains first-poll
  priority each time.
- A wait extended after its line is written is not logged again, and a wait shorter than
  a tick is logged after it ended.
- The count in the line covers monitors that asked in the last ten minutes: one not yet
  polled since the daemon started is left out, and one stopped within ten minutes is in.
- A successful answer with no requests left does not start a wait; the next request
  meets the limit and starts it.
- A monitor created during a wait primes after it, so changes made during the wait count
  as already seen.

```ts
const github = GithubClient.open(
  token,
  monitorId,
  ["graphql", "rest"],
  first,
  http,
  now,
);
if (!github) return DEFERRED;

return deferOnWait(() =>
  readPullRequest(github, repo, prNumber, cursor, primed),
);
```
