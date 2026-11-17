import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import type { YabSourceRecord } from "./types"
import { YabMonitor } from "./index"
import { callYabTool, feedEvents, fetchThroughYab, parseFeed, parseYabFetch, pollYab } from "./poll"

const source: YabSourceRecord = { type: "yab", url: "https://mail.google.com/mail/u/0/feed/atom", space: "Personal" }

const atom = (entries: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox</title>${entries}</feed>`

const gmailEntry = (id: string, title: string, name = "Ali from HiringCafe", email = "ali@hiring.cafe"): string =>
  `<entry><title>${title}</title><summary>Last night \u200c\u200b\u200dyour agent found jobs&amp;more</summary><link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=a@b.c&amp;message_id=${id}&amp;view=conv" type="text/html"/><modified>2026-11-06T09:40:00Z</modified><issued>2026-11-06T09:40:00Z</issued><id>tag:gmail.google.com,2004:${id}</id><author><name>${name}</name><email>${email}</email></author></entry>`

describe("Yab monitor source", () => {
  test("builds a feed source with its optional space and filters", () => {
    assert.deepEqual(new YabMonitor().build({ url: "https://example.com/feed.xml", space: "Work", match: "interview", exclude: "newsletter" }), {
      type: "yab",
      url: "https://example.com/feed.xml",
      space: "Work",
      match: "interview",
      exclude: "newsletter",
    })
  })

  test("rejects a missing or non-http URL and a broken pattern", () => {
    const monitor = new YabMonitor()
    assert.deepEqual(monitor.build({}), { error: "url is required for a yab monitor" })
    assert.deepEqual(monitor.build({ url: "not a url" }), { error: "url must be a valid http(s) URL" })
    assert.deepEqual(monitor.build({ url: "file:///etc/passwd" }), { error: "url must be a valid http(s) URL" })
    assert.deepEqual(monitor.build({ url: "https://example.com/feed", match: "(" }), { error: "match must be a valid regular expression" })
  })

  test("validates stored sources and polls", () => {
    const monitor = new YabMonitor()
    assert.deepEqual(monitor.validateSource(source), source)
    assert.equal(monitor.initialDelivery(source), "poll")
    assert.equal(monitor.describe(source), "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)")
  })
})

describe("feed parsing", () => {
  test("reads Gmail's Atom feed", () => {
    const [entry] = parseFeed(atom(gmailEntry("1a2b", "114 new jobs posted that match your AI Search")), "text/xml; charset=UTF-8")
    assert.deepEqual(entry, {
      id: "tag:gmail.google.com,2004:1a2b",
      title: "114 new jobs posted that match your AI Search",
      summary: "Last night your agent found jobs&more",
      author: "Ali from HiringCafe <ali@hiring.cafe>",
      link: "https://mail.google.com/mail/u/0?account_id=a@b.c&message_id=1a2b&view=conv",
      at: "2026-11-06T09:40:00.000Z",
    })
  })

  test("reads RSS items with CDATA and escaped HTML", () => {
    const rss = '<rss version="2.0"><channel><title>Jobs</title><item><title><![CDATA[Staff Engineer & Lead]]></title><link>https://jobs.example.com/1</link><guid isPermaLink="false">job-1</guid><description>&lt;p&gt;Remote &amp;amp; Bengaluru&lt;/p&gt;</description><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Acme</dc:creator></item></channel></rss>'
    assert.deepEqual(parseFeed(rss), [{
      id: "job-1",
      title: "Staff Engineer & Lead",
      summary: "Remote &amp; Bengaluru",
      author: "Acme",
      link: "https://jobs.example.com/1",
      at: "2026-11-06T10:00:00.000Z",
    }])
  })

  test("reads a JSON feed", () => {
    const json = JSON.stringify({ items: [{ id: 7, title: "Hi", content_text: "Body", url: "https://e.com/7", date_published: "2026-11-06T10:00:00Z", authors: [{ name: "Eve" }] }] })
    assert.deepEqual(parseFeed(json, "application/json"), [{ id: "7", title: "Hi", summary: "Body", author: "Eve", link: "https://e.com/7", at: "2026-11-06T10:00:00.000Z" }])
  })

  test("reads an empty feed and refuses a page that is not one", () => {
    assert.deepEqual(parseFeed(atom("")), [])
    assert.throws(() => parseFeed("<html><body>Sign in</body></html>", "text/html"), /not an Atom, RSS or JSON feed/)
  })
})

describe("feed cursor", () => {
  test("primes what is already there and reports only later entries", () => {
    const first = feedEvents(source, parseFeed(atom(gmailEntry("1", "Old alert"))), undefined)
    assert.equal(first.events.length, 0)
    assert.deepEqual(first.cursor, { primed: true, seenIds: ["tag:gmail.google.com,2004:1"] })

    const second = feedEvents(source, parseFeed(atom(gmailEntry("2", "New alert") + gmailEntry("1", "Old alert"))), first.cursor)
    assert.equal(second.events.length, 1)
    assert.partialDeepStrictEqual(second.events[0], {
      kind: "entry",
      id: "entry:tag:gmail.google.com,2004:2",
      summary: "Yab feed entry from Ali from HiringCafe <ali@hiring.cafe>: New alert",
      actionable: true,
    })
    assert.match(second.events[0]?.body ?? "", /message_id=2/)

    const third = feedEvents(source, parseFeed(atom(gmailEntry("2", "New alert"))), second.cursor)
    assert.equal(third.events.length, 0)
  })

  test("keeps only entries that match and do not match the exclusion", () => {
    const filtered: YabSourceRecord = { ...source, match: "interview|assessment", exclude: "webinar" }
    const primed = feedEvents(filtered, [], undefined).cursor
    const entries = parseFeed(atom(
      gmailEntry("a", "Interview for Staff SE", "Postman", "talent@postman.com") +
      gmailEntry("b", "Interview prep webinar", "Naukri", "info@naukri.com") +
      gmailEntry("c", "Your weekly digest", "Medium", "noreply@medium.com"),
    ))
    const result = feedEvents(filtered, entries, primed)
    assert.deepEqual(result.events.map((event) => event.id), ["entry:tag:gmail.google.com,2004:a"])
    assert.equal(result.cursor.seenIds.length, 3)
  })
})

describe("polling through Yab", () => {
  test("names a sign-in problem", async () => {
    await assert.rejects(
      pollYab(source, undefined, async () => ({ status: 401, type: "text/html", url: source.url, body: "" })),
      /answered 401; sign in to the site in Yab/,
    )
  })

  test("names the feed by host, never its path or query", async () => {
    const secret = { ...source, url: "https://example.test/feed/secret-path-token?token=secret-query-token" }
    const error = await pollYab(secret, undefined, async () => ({ status: 404, type: "text/html", url: secret.url, body: "" })).then(() => undefined, (failure: unknown) => failure)
    assert.ok(error instanceof Error)
    assert.match(error.message, /example\.test/)
    assert.ok(!error.message.includes("secret-path-token"), "the path is not logged")
    assert.ok(!error.message.includes("secret-query-token"), "the query is not logged")
  })

  test("asks Yab for the feed with the source's space", async () => {
    const asked: unknown[] = []
    const result = await pollYab(source, undefined, async (url, space) => {
      asked.push([url, space])
      return { status: 200, type: "text/xml", url, body: atom(gmailEntry("1", "Hello")) }
    })
    assert.deepEqual(asked, [[source.url, "Personal"]])
    assert.equal(result.cursor.primed, true)
    assert.equal(result.terminal, false)
  })

  test("splits Yab's fetch answer into status, type and body", () => {
    assert.deepEqual(parseYabFetch("200 · text/xml; charset=UTF-8 · https://e.com/feed\n\n<feed></feed>"), {
      status: 200,
      type: "text/xml; charset=UTF-8",
      url: "https://e.com/feed",
      body: "<feed></feed>",
    })
    assert.throws(() => parseYabFetch("no tab, see tabs"), /not the expected shape/)
  })

  test("an unexpected answer quotes nothing unless SOURCEFED_DEBUG is set", () => {
    const url = "https://example.test/feed/secret-path-token?token=secret-query-token"
    const failure = (() => {
      try {
        parseYabFetch(`nope · text/html · ${url}`, url)
      } catch (error) {
        return error as Error
      }
      return undefined
    })()

    assert.ok(failure)
    assert.equal(failure.message, "Yab's answer was not the expected shape")
    assert.ok(!failure.message.includes("example.test"), "Yab's own words are not quoted")

    process.env.SOURCEFED_DEBUG = "1"
    try {
      assert.throws(() => parseYabFetch(`nope · text/html · ${url}`, url), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /example\.test/)
        assert.ok(!error.message.includes("secret-path-token"), "the path is not quoted")
        assert.ok(!error.message.includes("secret-query-token"), "the query is not quoted")
        return true
      })
    } finally {
      delete process.env.SOURCEFED_DEBUG
    }
  })
})

const FAKE_YAB = `#!/usr/bin/env node
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-yab", version: "0" } })
    if (message.method !== "tools/call") continue
    const mode = process.env.FAKE_YAB_MODE
    if (mode === "error-object") return errorReply(message.id, { code: -1 })
    if (mode === "exit") process.exit(3)
    if (mode === "exit-leak") {
      process.stderr.write("fetching " + process.env.FAKE_YAB_URL + ": connection reset")
      process.exit(3)
    }
    if (mode === "leak-short") {
      process.stderr.write("GET /feed returned 401 while fetching " + process.env.FAKE_YAB_URL)
      process.exit(3)
    }
    if (mode === "leak") reply(message.id, { isError: true, content: [{ type: "text", text: "failed to read " + message.params.arguments.url + " and again " + message.params.arguments.url.replace(/^https?:\\/\\/[^/]+/, "") }] })
    else if (mode === "error") reply(message.id, { isError: true, content: [{ type: "text", text: "no such space" }] })
    else reply(message.id, { content: [{ type: "text", text: "200 · application/json · " + message.params.arguments.url + "\\n\\n" + JSON.stringify({ tool: message.params.name, args: message.params.arguments, argv: process.argv.slice(2) }) }] })
  }
})
function reply(id, result) {
  process.stdout.write("not json noise\\n" + JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
}
function errorReply(id, error) {
  process.stdout.write("not json noise\\n" + JSON.stringify({ jsonrpc: "2.0", id, error }) + "\\n")
}
`

describe("Yab MCP client", () => {
  let dir = ""
  const realCommand = process.env.SOURCEFED_YAB_COMMAND

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sourcefed-yab-"))
    const fake = path.join(dir, "yab")
    writeFileSync(fake, FAKE_YAB)
    chmodSync(fake, 0o755)
    process.env.SOURCEFED_YAB_COMMAND = fake
  })

  after(() => {
    if (realCommand === undefined) delete process.env.SOURCEFED_YAB_COMMAND
    else process.env.SOURCEFED_YAB_COMMAND = realCommand
    delete process.env.FAKE_YAB_MODE
    delete process.env.FAKE_YAB_URL
    delete process.env.SOURCEFED_DEBUG
    rmSync(dir, { recursive: true, force: true })
  })

  test("calls Yab's fetch tool over stdio", async () => {
    delete process.env.FAKE_YAB_MODE
    const page = await fetchThroughYab("https://e.com/feed", "Personal")
    assert.equal(page.status, 200)
    assert.deepEqual(JSON.parse(page.body), {
      tool: "fetch",
      args: { url: "https://e.com/feed", html: true, space: "Personal" },
      argv: ["mcp"],
    })
  })

  test("reports a tool error and a server that quits", async () => {
    process.env.FAKE_YAB_MODE = "error"
    await assert.rejects(callYabTool("fetch", { url: "https://e.com" }), /Yab reported the fetch failed/)
    process.env.FAKE_YAB_MODE = "exit"
    await assert.rejects(callYabTool("fetch", { url: "https://e.com" }), /Yab exited \(3\) before answering/)
  })

  test("no byte of Yab's own words reaches the failure unless asked", async () => {
    const url = "https://example.test/feed/secret-path-token?token=secret-query-token"
    process.env.FAKE_YAB_MODE = "leak"
    const toolFailure = await callYabTool("fetch", { url }).then(() => undefined, (error: unknown) => error)
    assert.ok(toolFailure instanceof Error)
    assert.equal(toolFailure.message, "Yab reported the fetch failed")

    process.env.FAKE_YAB_MODE = "exit-leak"
    process.env.FAKE_YAB_URL = url
    const exitFailure = await callYabTool("fetch", { url }).then(() => undefined, (error: unknown) => error)
    assert.ok(exitFailure instanceof Error)
    assert.equal(exitFailure.message, "Yab exited (3) before answering")
    delete process.env.FAKE_YAB_MODE
    delete process.env.FAKE_YAB_URL
  })

  test("SOURCEFED_DEBUG quotes Yab's words redacted, and keeps a short path", async () => {
    const url = "https://example.test/feed?x=1"
    process.env.FAKE_YAB_MODE = "leak-short"
    process.env.FAKE_YAB_URL = url
    process.env.SOURCEFED_DEBUG = "1"
    try {
      const failure = await callYabTool("fetch", { url }).then(() => undefined, (error: unknown) => error)
      assert.ok(failure instanceof Error)
      assert.match(failure.message, /example\.test/, "the URL is cut to its host")
      assert.match(failure.message, /GET \/feed returned 401/, "a short path is not stripped from the text")
    } finally {
      delete process.env.FAKE_YAB_MODE
      delete process.env.FAKE_YAB_URL
      delete process.env.SOURCEFED_DEBUG
    }
  })

  test("an error without a message does not crash and is still refused", async () => {
    process.env.FAKE_YAB_MODE = "error-object"
    const failure = await callYabTool("fetch", { url: "https://e.com" }).then(() => undefined, (error: unknown) => error)
    delete process.env.FAKE_YAB_MODE
    assert.ok(failure instanceof Error)
    assert.equal(failure.message, "Yab answered with an error (code -1)")
  })

  test("reports a missing Yab", async () => {
    process.env.SOURCEFED_YAB_COMMAND = path.join(dir, "missing")
    await assert.rejects(callYabTool("fetch", { url: "https://e.com" }), /Yab could not start/)
    process.env.SOURCEFED_YAB_COMMAND = path.join(dir, "yab")
  })
})
