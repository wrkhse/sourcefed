import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { toMonitorEvent } from "@sourcefed/core"

const BASE = "https://example.atlassian.net"
process.env.SOURCEFED_JIRA_BASE_URL = BASE
process.env.ATLASSIAN_EMAIL = "test@example.com"
process.env.ATLASSIAN_API_KEY = "test-key"
delete process.env.SOURCEFED_JIRA_TERMINAL_STATUS

// jira-fetch reads the base URL once, at import, so the test sets it before loading the poll.
const { pollJira } = await import("./poll-jira.ts")

// No test calls Jira: fetch is replaced by a fake Jira.
const realFetch = globalThis.fetch
const SOURCE = { type: "jira", issueKey: "PROJ-9" }

type FakeJira = { summary?: string; description: unknown; requests: string[] }

function installJira(summary: string | undefined): FakeJira {
  const fake: FakeJira = { summary, description: { content: [{ text: "first" }] }, requests: [] }
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input))
    fake.requests.push(`${url.pathname}${url.search}`)
    if (url.pathname.endsWith("/comment")) return Response.json({ comments: [] })
    return Response.json({
      fields: { status: { name: "In Progress" }, description: fake.description, summary: fake.summary },
      changelog: { histories: [] },
    })
  }) as typeof fetch
  return fake
}

// Two polls: the first primes the description, and the second reports its change.
async function eventsAfterDescriptionChange(fake: FakeJira): ReturnType<typeof pollJira> {
  const first = await pollJira("PROJ-9", undefined)
  assert.deepEqual(first.events, [])
  fake.description = { content: [{ text: "second" }] }
  return pollJira("PROJ-9", first.cursor)
}

describe("Jira issue poll subjects", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("asks for the status, description and summary it reads", async () => {
    const fake = installJira("Add schedules")

    await pollJira("PROJ-9", undefined)

    const issueRequest = fake.requests.find((path) => path.startsWith("/rest/api/3/issue/PROJ-9?"))
    assert.ok(issueRequest, "the issue request was sent")
    assert.equal(new URLSearchParams(issueRequest.split("?")[1]).get("fields"), "status,description,summary")
  })

  test("one poll reads the comments and the issue in two requests", async () => {
    const fake = installJira("Add schedules")

    await pollJira("PROJ-9", undefined)

    assert.equal(fake.requests.length, 2)
    assert.equal(fake.requests[0]?.startsWith("/rest/api/3/issue/PROJ-9/comment?"), true)
    assert.equal(fake.requests[1]?.startsWith("/rest/api/3/issue/PROJ-9?"), true)
  })

  test("an event carries the summary as its subject title, trimmed, and keeps it as a monitor event", async () => {
    const fake = installJira("  Add schedules ")

    const result = await eventsAfterDescriptionChange(fake)

    assert.equal(result.events.length, 1)
    const subject = { type: "jira-issue", key: "PROJ-9", url: `${BASE}/browse/PROJ-9`, title: "Add schedules" }
    assert.deepEqual(result.events[0]!.subject, subject)
    assert.deepEqual(toMonitorEvent(result.events[0]!, SOURCE).subject, subject)
  })

  test("an empty summary omits the title property", async () => {
    const fake = installJira("   ")

    const result = await eventsAfterDescriptionChange(fake)

    assert.deepEqual(result.events[0]!.subject, { type: "jira-issue", key: "PROJ-9", url: `${BASE}/browse/PROJ-9` })
    assert.equal("title" in result.events[0]!.subject!, false)
  })
})
