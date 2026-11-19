import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { MAX_COMMENT_BODY, postIssueComment, type GithubRequest } from "./client.ts"

const TOKEN = "test-token"
const HTML_URL = "https://github.com/org/repo/issues/12#issuecomment-99"

describe("postIssueComment", () => {
  test("posts one comment with the exact request shape and returns its fields", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const send: GithubRequest = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 99, html_url: HTML_URL }), { status: 201, headers: { "content-type": "application/json" } })
    }

    const result = await postIssueComment(send, TOKEN, "org/repo", 12, "  hello  ")

    assert.deepEqual(result, { id: 99, html_url: HTML_URL })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.github.com/repos/org/repo/issues/12/comments")
    const init = calls[0].init!
    assert.equal(init.method, "POST")
    assert.deepEqual(init.headers, {
      accept: "application/vnd.github+json",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "user-agent": "sourcefed",
      "x-github-api-version": "2022-11-28",
    })
    assert.equal(init.body, JSON.stringify({ body: "  hello  " }))
    assert.ok(init.signal instanceof AbortSignal)
  })

  const badInputs: Array<[string, string, number, string]> = [
    ["an empty body", "org/repo", 12, "   "],
    ["an over-long body", "org/repo", 12, "x".repeat(MAX_COMMENT_BODY + 1)],
    ["a malformed repo", "not a repo", 12, "hello"],
    ["a zero issue number", "org/repo", 0, "hello"],
    ["a fractional issue number", "org/repo", 1.5, "hello"],
  ]
  for (const [name, repo, issueNumber, body] of badInputs) {
    test(`rejects ${name} without making a request`, async () => {
      let requests = 0
      const send: GithubRequest = async () => {
        requests += 1
        return new Response("{}")
      }

      await assert.rejects(postIssueComment(send, TOKEN, repo, issueNumber, body))
      assert.equal(requests, 0)
    })
  }
})
