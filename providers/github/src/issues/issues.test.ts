import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as v from "valibot"
import { GithubIssuesMonitor, githubIssuesSource } from "./monitor.ts"
import { pollGithubIssues } from "./poll.ts"
import { GithubIssuesSourceSchema, type GithubIssuesSource } from "./schema.ts"
import { ETAG, REPO, issue, listReply, nextPage, notModified, pullRequest, searchReply, type RecordedIssue } from "./fixtures/recorded-replies.ts"
import { parseIssueCommentWebhook } from "./webhook.ts"

const source: GithubIssuesSource = { type: "github-issues", repo: REPO, labels: ["atelier:build"] }
const now = () => new Date("2026-11-13T10:00:00.000Z")

type Call = { url: string; headers: Record<string, string> }

function github(...replies: Array<(call: Call) => Response>) {
  const calls: Call[] = []
  const request = async (url: string, headers: Record<string, string>): Promise<Response> => {
    const call = { url, headers }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`unexpected request ${url}`)
    return reply(call)
  }
  return { calls, request }
}

const list = (items: RecordedIssue[], options?: { etag?: string; next?: string }) => () => listReply(items, options)
const direct = (item: RecordedIssue) => () => new Response(JSON.stringify(item), { status: 200, headers: { "content-type": "application/json" } })
const missing = () => () => new Response('{"message":"Not Found"}', { status: 404, headers: { "content-type": "application/json" } })
const gone = () => () => new Response('{"message":"Gone"}', { status: 410, headers: { "content-type": "application/json" } })
const redirected = (location: string, status = 301) => () => new Response(null, { status, headers: { location } })
const noLocation = () => () => new Response(null, { status: 301 })
const numbered: GithubIssuesSource = { type: "github-issues", repo: REPO, issueNumbers: [56, 57] }

describe("github-issues", () => {
  test("the first poll primes silently and keeps the list's ETag", async () => {
    const { request, calls } = github(list([issue(48), issue(49)], { etag: ETAG }))

    const result = await pollGithubIssues(source, undefined, request, now)

    assert.deepEqual(result.events, [])
    assert.deepEqual(result.cursor, { primed: true, keys: [`${REPO}#48`, `${REPO}#49`], overLimit: false, etag: ETAG })
    assert.match(calls[0].url, /\/repos\/example-org\/example-repo\/issues\?state=open&labels=atelier%3Abuild&per_page=100$/)
  })

  test("a label added sends item.matched with the issue's subject", async () => {
    const primed = { primed: true, keys: [`${REPO}#48`], overLimit: false, etag: ETAG }
    const { request, calls } = github(list([issue(48), issue(50, "Add schedules")], { etag: 'W/"next"' }))

    const result = await pollGithubIssues(source, primed, request, now)

    assert.equal(calls[0].headers["if-none-match"], ETAG)
    assert.deepEqual(result.events, [{
      kind: "item.matched",
      id: `item.matched:${REPO}#50:2026-11-13T10:00:00.000Z`,
      at: "2026-11-13T10:00:00.000Z",
      summary: `GitHub issue ${REPO}#50 matches label atelier:build: Add schedules`,
      body: `https://github.com/${REPO}/issues/50`,
      actionable: true,
      subject: {
        type: "github-issue",
        key: `${REPO}#50`,
        repo: REPO,
        number: 50,
        url: `https://github.com/${REPO}/issues/50`,
        title: "Add schedules",
      },
    }])
  })

  test("a label removed or an issue closed sends item.unmatched", async () => {
    const primed = { primed: true, keys: [`${REPO}#48`, `${REPO}#49`], overLimit: false }
    const { request } = github(list([issue(49)]))

    const result = await pollGithubIssues(source, primed, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.key, event.actionable]), [
      ["item.unmatched", `${REPO}#48`, false],
    ])
    assert.equal(result.events[0].subject?.number, 48)
  })

  test("a 304 sends nothing and keeps the cursor", async () => {
    const primed = { primed: true, keys: [`${REPO}#48`], overLimit: false, etag: ETAG }
    const { request } = github(() => notModified())

    const result = await pollGithubIssues(source, primed, request, now)

    assert.deepEqual(result.events, [])
    assert.equal(result.cursor, primed)
  })

  test("includeExisting sends item.matched for every current issue on the first poll", async () => {
    const { request } = github(list([issue(48), issue(49)]))

    const result = await pollGithubIssues({ ...source, includeExisting: true }, undefined, request, now)

    assert.deepEqual(result.events.map((event) => event.subject?.number), [48, 49])
  })

  test("follows the Link header across pages, skips pull requests, and keeps no ETag", async () => {
    const { request, calls } = github(
      list([issue(48), pullRequest(47)], { etag: ETAG, next: nextPage(2) }),
      list([issue(12)], { etag: 'W/"page-2"' }),
      list([issue(48), issue(12)]),
    )

    const first = await pollGithubIssues(source, undefined, request, now)
    await pollGithubIssues(source, first.cursor, request, now)

    assert.equal(calls[1].url, nextPage(2))
    assert.deepEqual(first.cursor, { primed: true, keys: [`${REPO}#48`, `${REPO}#12`], overLimit: false })
    assert.equal(calls[2].headers["if-none-match"], undefined)
  })

  test("past 1,000 issues, reports one error and reports nothing unmatched", async () => {
    const primed = { primed: true, keys: [`${REPO}#1`], overLimit: false }
    const pages = Array.from({ length: 11 }, (_, page) => {
      const items = Array.from({ length: 100 }, (_, index) => issue(page * 100 + index + 1))
      return list(items, { next: nextPage(page + 2) })
    })
    const { request, calls } = github(...pages, ...pages)

    const first = await pollGithubIssues(source, primed, request, now)
    const second = await pollGithubIssues(source, first.cursor, request, now)

    assert.equal(calls.length, 22)
    assert.deepEqual(first.events.map((event) => event.kind), ["error"])
    assert.match(first.events[0].summary, /More than 1,000 GitHub issues/)
    assert.deepEqual(first.cursor, { primed: true, keys: [`${REPO}#1`], overLimit: true })
    assert.deepEqual(second.events, [])
  })

  test("a failed reply throws, so the poll keeps its cursor", async () => {
    const { request } = github(() => new Response('{"message":"Server Error"}', { status: 502 }))

    await assert.rejects(pollGithubIssues(source, undefined, request, now), /GitHub 502 for \/repos\/example-org\/example-repo\/issues/)
  })

  test("a query searches, and refuses incomplete results", async () => {
    const withQuery = { ...source, assignee: "octocat", query: "milestone:v2" }
    const { request, calls } = github(() => searchReply([issue(48)]), () => searchReply([], 0, true))

    const result = await pollGithubIssues({ ...withQuery, includeExisting: true }, undefined, request, now)

    const query = new URL(calls[0].url).searchParams.get("q")
    assert.equal(query, `repo:${REPO} is:issue is:open label:"atelier:build" assignee:octocat milestone:v2`)
    assert.deepEqual(result.events.map((event) => event.subject?.number), [48])
    await assert.rejects(pollGithubIssues(withQuery, result.cursor, request, now), /incomplete results/)
  })

  test("a search past 1,000 results reports the limit", async () => {
    const { request } = github(() => searchReply([issue(1)], 1_001))

    const result = await pollGithubIssues({ ...source, query: "is:public" }, undefined, request, now)

    assert.deepEqual(result.events.map((event) => event.kind), ["error"])
  })

  test("a numbered source primes from direct reads, in order, without an ETag", async () => {
    const { request, calls } = github(direct(issue(56)), direct(issue(57)))

    const result = await pollGithubIssues(numbered, undefined, request, now)

    assert.deepEqual(result.events, [])
    assert.deepEqual(result.cursor, { primed: true, keys: [`${REPO}#56`, `${REPO}#57`], overLimit: false })
    assert.deepEqual(calls.map((call) => call.url), [
      `https://api.github.com/repos/${REPO}/issues/56`,
      `https://api.github.com/repos/${REPO}/issues/57`,
    ])
    assert.deepEqual(calls.map((call) => call.headers), [{}, {}])
  })

  test("a numbered source with includeExisting reports every found issue on the first poll", async () => {
    const { request } = github(direct(issue(56, "Issue 56")), direct(issue(57, "Issue 57")))

    const result = await pollGithubIssues({ ...numbered, includeExisting: true }, undefined, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.number]), [
      ["item.matched", 56],
      ["item.matched", 57],
    ])
  })

  test("a numbered source reports matched and unmatched from its direct reads", async () => {
    const primed = { primed: true, keys: [`${REPO}#56`, `${REPO}#57`], overLimit: false }
    const { request } = github(direct(issue(56)), direct(issue(58, "Issue 58")))

    const result = await pollGithubIssues(numbered, primed, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.key]), [
      ["item.unmatched", `${REPO}#57`],
      ["item.matched", `${REPO}#58`],
    ])
  })

  test("a numbered source treats a missing issue as absent so the rest is still read", async () => {
    const primed = { primed: true, keys: [`${REPO}#56`], overLimit: false }
    const { request, calls } = github(missing(), direct(issue(57)))

    const result = await pollGithubIssues(numbered, primed, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.key]), [
      ["item.unmatched", `${REPO}#56`],
      ["item.matched", `${REPO}#57`],
    ])
    assert.equal(calls.length, 2)
    assert.deepEqual(result.cursor, { primed: true, keys: [`${REPO}#57`], overLimit: false })
  })

  test("a numbered source reports a closed issue as unmatched", async () => {
    const primed = { primed: true, keys: [`${REPO}#56`], overLimit: false }
    const closed = { ...issue(56), state: "closed" }
    const { request } = github(direct(closed))

    const result = await pollGithubIssues({ ...numbered, issueNumbers: [56] }, primed, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.key]), [
      ["item.unmatched", `${REPO}#56`],
    ])
    assert.deepEqual(result.cursor, { primed: true, keys: [], overLimit: false })
  })

  test("a numbered source treats a 410 as absent like a 404", async () => {
    const primed = { primed: true, keys: [`${REPO}#56`], overLimit: false }
    const { request } = github(gone(), direct(issue(57)))

    const result = await pollGithubIssues(numbered, primed, request, now)

    assert.deepEqual(result.events.map((event) => [event.kind, event.subject?.key]), [
      ["item.unmatched", `${REPO}#56`],
      ["item.matched", `${REPO}#57`],
    ])
  })

  test("a numbered source follows one 301 or 302 for a direct read", async () => {
    const location = `https://api.github.com/repos/${REPO}/issues/56?moved=1`

    for (const status of [301, 302]) {
      const { request, calls } = github(redirected(location, status), direct(issue(56)))

      const result = await pollGithubIssues({ ...numbered, issueNumbers: [56], includeExisting: true }, undefined, request, now)

      assert.deepEqual(calls.map((call) => call.url), [
        `https://api.github.com/repos/${REPO}/issues/56`,
        location,
      ])
      assert.deepEqual(result.cursor, { primed: true, keys: [`${REPO}#56`], overLimit: false })
    }
  })

  test("a numbered source does not follow a second redirect", async () => {
    const location = `https://api.github.com/repos/${REPO}/issues/56?moved=1`
    const { request, calls } = github(redirected(location), redirected(location))

    await assert.rejects(pollGithubIssues({ ...numbered, issueNumbers: [56] }, undefined, request, now), /GitHub 301/)

    assert.equal(calls.length, 2)
  })

  test("a numbered source refuses a redirect without a location", async () => {
    const { request } = github(noLocation())

    await assert.rejects(pollGithubIssues({ ...numbered, issueNumbers: [56] }, undefined, request, now), /example-org\/example-repo#56 redirected without a location/)
  })

  test("a numbered source refuses a redirect off the GitHub API origin", async () => {
    const location = "https://evil.example/repos/example-org/example-repo/issues/56"
    const { request, calls } = github(redirected(location, 302))

    await assert.rejects(pollGithubIssues({ ...numbered, issueNumbers: [56] }, undefined, request, now), /example-org\/example-repo#56 redirected off-origin to https:\/\/evil\.example/)

    assert.equal(calls.length, 1)
  })

  test("a numbered source follows an absolute redirect on the GitHub API origin", async () => {
    const location = `https://api.github.com/repos/${REPO}/issues/56?moved=1`
    const { request, calls } = github(redirected(location, 302), direct(issue(56)))

    const result = await pollGithubIssues({ ...numbered, issueNumbers: [56], includeExisting: true }, undefined, request, now)

    assert.deepEqual(calls.map((call) => call.url), [
      `https://api.github.com/repos/${REPO}/issues/56`,
      location,
    ])
    assert.deepEqual(result.cursor, { primed: true, keys: [`${REPO}#56`], overLimit: false })
  })

  test("a numbered source refuses a malformed redirect location", async () => {
    const { request, calls } = github(redirected("not a url", 302))

    await assert.rejects(pollGithubIssues({ ...numbered, issueNumbers: [56] }, undefined, request, now), /example-org\/example-repo#56 redirected to a malformed location/)

    assert.equal(calls.length, 1)
  })

  test("a numbered source skips a pull request", async () => {
    const { request } = github(direct(pullRequest(56)))

    const result = await pollGithubIssues({ ...numbered, issueNumbers: [56], includeExisting: true }, undefined, request, now)

    assert.deepEqual(result.events, [])
    assert.deepEqual(result.cursor, { primed: true, keys: [], overLimit: false })
  })
})

describe("GithubIssuesMonitor", () => {
  const monitor = GithubIssuesMonitor

  test("builds a source with sorted, distinct labels", () => {
    const built = monitor.build({ repo: REPO, labels: ["b", "a", "b", " "], includeExisting: true })

    assert.deepEqual(built, { type: "github-issues", repo: REPO, labels: ["a", "b"], includeExisting: true })
  })

  test("refuses a source without a repository or labels", () => {
    assert.deepEqual(monitor.build({ labels: ["a"] }), { error: "repo must be owner/name for a github-issues monitor" })
    assert.deepEqual(monitor.build({ repo: REPO, labels: [] }), { error: "labels is required for a github-issues monitor" })
  })

  test("wakes on the repository's issues webhooks only", () => {
    const payload = { action: "labeled", repository: { full_name: "Example-Org/Example-Repo" } }
    const wake = monitor.wake
    assert.ok(wake, "github-issues wakes on the issues webhook")

    assert.equal(wake.matches(source, payload, "issues"), true)
    assert.equal(wake.matches(source, payload, "pull_request"), false)
    assert.equal(wake.matches(source, { repository: { full_name: "other/repo" } }, "issues"), false)
  })

  test("builds a numbered source from sorted, distinct issue numbers", () => {
    const built = monitor.build({ repo: REPO, issueNumbers: [57, 56], includeExisting: true })

    assert.deepEqual(built, { type: "github-issues", repo: REPO, issueNumbers: [56, 57], includeExisting: true })
  })

  test("builds a numbered source with no label filters", () => {
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [56] }), {
      type: "github-issues",
      repo: REPO,
      issueNumbers: [56],
    })
  })

  test("refuses label filters on a numbered source", () => {
    const error = { error: "assignee, author and query do not apply with issueNumbers" }

    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [56], assignee: "octocat" }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [56], author: "octocat" }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [56], query: "milestone:v2" }), error)
  })

  test("refuses malformed issue numbers", () => {
    const error = { error: "issueNumbers must be positive integers, at most 100, without duplicates" }

    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [0] }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [-1] }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [1.5] }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: Array.from({ length: 101 }, (_, i) => i + 1) }), error)
    assert.deepEqual(monitor.build({ repo: REPO, issueNumbers: [56, 56] }), error)
  })

  test("refuses both selectors, or neither", () => {
    assert.deepEqual(monitor.build({ repo: REPO, labels: ["a"], issueNumbers: [56] }), {
      error: "give either labels or issueNumbers for a github-issues monitor, not both",
    })
    assert.deepEqual(monitor.build({ repo: REPO }), { error: "give labels or issueNumbers for a github-issues monitor" })
  })

  test("keys name the numbered set and leave label keys alone", () => {
    assert.equal(monitor.key(numbered), "github-issues:example-org/example-repo:numbers:56,57")
    assert.notEqual(monitor.key(numbered), monitor.key({ ...numbered, issueNumbers: [56] }))
    assert.equal(monitor.key(source), "github-issues:example-org/example-repo:atelier:build:::")
  })

  test("a numbered source wakes only for its own issue numbers", () => {
    const payload = (issueNumber: number, fullName = "Example-Org/Example-Repo") => ({
      action: "labeled",
      issue: { number: issueNumber },
      repository: { full_name: fullName },
    })
    const wake = monitor.wake
    assert.ok(wake, "github-issues wakes on the issues webhook")

    assert.equal(wake.matches(numbered, payload(56), "issues"), true)
    assert.equal(wake.matches(numbered, payload(58), "issues"), false)
    assert.equal(wake.matches(numbered, payload(56), "pull_request"), false)
    assert.equal(wake.matches(numbered, payload(56, "other/repo"), "issues"), false)
  })
})

describe("GithubIssuesSourceSchema", () => {
  const base = { type: "github-issues" as const, repo: REPO }
  const messages = (result: v.SafeParseResult<v.GenericSchema>) => result.issues?.map((issue) => issue.message)

  test("accepts exactly one non-empty selector", () => {
    assert.equal(v.safeParse(GithubIssuesSourceSchema, { ...base, labels: ["a"] }).success, true)
    assert.equal(v.safeParse(GithubIssuesSourceSchema, { ...base, issueNumbers: [56] }).success, true)
  })

  test("refuses a stored source with neither selector", () => {
    const result = v.safeParse(GithubIssuesSourceSchema, base)

    assert.equal(result.success, false)
    assert.deepEqual(messages(result), ["give either labels or issueNumbers for a github-issues monitor"])
  })

  test("refuses both selectors and either empty selector", () => {
    const sources = [
      { ...base, labels: ["a"], issueNumbers: [56] },
      { ...base, labels: [], issueNumbers: [56] },
      { ...base, labels: ["a"], issueNumbers: [] },
    ]

    for (const source of sources) assert.equal(v.safeParse(GithubIssuesSourceSchema, source).success, false)
  })

  test("refuses malformed issue numbers with the shared reason", () => {
    const issueNumbers = [[0], [1.5], [56, 56], Array.from({ length: 101 }, (_, i) => i + 1)]

    for (const numbers of issueNumbers) {
      const result = v.safeParse(GithubIssuesSourceSchema, { ...base, issueNumbers: numbers })
      assert.equal(result.success, false)
      assert.deepEqual(messages(result), ["issueNumbers must be positive integers, at most 100, without duplicates"])
    }
  })
})

describe("parseIssueCommentWebhook", () => {
  const payload = {
    action: "created",
    repository: { full_name: REPO },
    issue: { number: 56, title: "Issue 56", html_url: `https://github.com/${REPO}/issues/56` },
    comment: {
      id: 901,
      body: "Please bound it.",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00.000Z",
    },
    sender: { login: "alice" },
  }

  test("a created comment on a plain issue becomes an issue.comment event", () => {
    assert.deepEqual(parseIssueCommentWebhook(payload, now), {
      source: { type: "github-issues", repo: REPO, issueNumbers: [56] },
      kind: "issue.comment",
      id: `issue.comment:${REPO}#56:901`,
      at: "2026-11-14T09:00:00.000Z",
      summary: `New comment by alice on GitHub issue ${REPO}#56`,
      body: "Please bound it.",
      actionable: true,
      subject: {
        type: "github-issue",
        key: `${REPO}#56`,
        repo: REPO,
        number: 56,
        url: `https://github.com/${REPO}/issues/56`,
        commentId: 901,
        author: "alice",
        title: "Issue 56",
      },
    })
  })

  test("falls back to the sender, a constructed url, the clock and no title", () => {
    const bare = {
      action: "created",
      repository: { full_name: "Example-Org/Example-Repo" },
      issue: { number: 7 },
      comment: { id: 42, body: "Ping" },
      sender: { login: "bob" },
    }

    assert.deepEqual(parseIssueCommentWebhook(bare, now), {
      source: { type: "github-issues", repo: "Example-Org/Example-Repo", issueNumbers: [7] },
      kind: "issue.comment",
      id: "issue.comment:Example-Org/Example-Repo#7:42",
      at: "2026-11-13T10:00:00.000Z",
      summary: "New comment by bob on GitHub issue Example-Org/Example-Repo#7",
      body: "Ping",
      actionable: true,
      subject: {
        type: "github-issue",
        key: "Example-Org/Example-Repo#7",
        repo: "Example-Org/Example-Repo",
        number: 7,
        url: "https://github.com/Example-Org/Example-Repo/issues/7",
        commentId: 42,
        author: "bob",
      },
    })
  })

  test("edited and deleted comments deliver nothing", () => {
    assert.equal(parseIssueCommentWebhook({ ...payload, action: "edited" }, now), undefined)
    assert.equal(parseIssueCommentWebhook({ ...payload, action: "deleted" }, now), undefined)
  })

  test("a comment on a pull request is left to the PR source", () => {
    const pr = { ...payload, issue: { ...payload.issue, pull_request: { html_url: "https://github.com/example-org/example-repo/pull/56" } } }

    assert.equal(parseIssueCommentWebhook(pr, now), undefined)
  })

  test("malformed payloads deliver nothing", () => {
    const malformed = [
      undefined,
      null,
      "not an object",
      {},
      { action: "created" },
      { ...payload, repository: { full_name: "not a repo" } },
      { ...payload, repository: { full_name: 5 } },
      { ...payload, issue: { ...payload.issue, number: 0 } },
      { ...payload, issue: { ...payload.issue, number: 1.5 } },
      { ...payload, comment: { ...payload.comment, id: "nope" } },
      { ...payload, comment: { ...payload.comment, user: undefined }, sender: undefined },
      { ...payload, comment: { ...payload.comment, body: undefined } },
    ]

    for (const input of malformed) assert.equal(parseIssueCommentWebhook(input, now), undefined)
  })
})

describe("githubIssuesSource webhook", () => {
  const event = parseIssueCommentWebhook({
    action: "created",
    repository: { full_name: REPO },
    issue: { number: 56, html_url: `https://github.com/${REPO}/issues/56` },
    comment: { id: 901, body: "Ping", user: { login: "alice" } },
    sender: { login: "alice" },
  }, now)!
  const webhook = githubIssuesSource.webhook!
  const matches = webhook.matches!
  const watched: GithubIssuesSource = { type: "github-issues", repo: REPO, issueNumbers: [56, 57] }
  const labelled: GithubIssuesSource = { type: "github-issues", repo: REPO, labels: ["agent"] }

  test("polling stays the primary transport", () => {
    assert.equal(webhook.preferred, false)
  })

  test("matches a watched issue number in the same repo, case-insensitively", () => {
    assert.equal(matches(watched, event), true)
    assert.equal(matches({ ...watched, repo: "EXAMPLE-ORG/EXAMPLE-REPO" }, event), true)
  })

  test("rejects an unwatched number, another repo, a label-only source and other kinds", () => {
    assert.equal(matches({ ...watched, issueNumbers: [58] }, event), false)
    assert.equal(matches({ ...watched, repo: "other/repo" }, event), false)
    assert.equal(matches(labelled, event), false)
    assert.equal(matches(watched, { ...event, kind: "item.matched" }), false)
    assert.equal(matches(watched, { ...event, source: { type: "github", repo: REPO } }), false)
    assert.equal(matches(watched, { ...event, source: { type: "github-issues", repo: "other/repo" } }), false)
  })
})
