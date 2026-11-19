import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { connectDaemonClient } from "./client.ts"

const realFetch = globalThis.fetch
const BASE = "http://127.0.0.1:18787"
const URL = "https://github.com/org/repo/issues/1#issuecomment-7"

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("daemon client comments", () => {
  test("comment.issue posts to /rpc with the exact params and resolves the result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json({ result: { id: 7, url: URL } })
    }
    const client = await connectDaemonClient({ name: "test", url: BASE })
    try {
      assert.deepEqual(await client.comment.issue({ repo: "org/repo", issueNumber: 1, body: "hello" }), { id: 7, url: URL })
    } finally {
      await client.close()
    }

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${BASE}/rpc`)
    assert.equal(calls[0].init?.method, "POST")
    const frame = JSON.parse(String(calls[0].init?.body)) as { id: number; method: string; params: unknown }
    assert.equal(frame.method, "comment.issue")
    assert.deepEqual(frame.params, { repo: "org/repo", issueNumber: 1, body: "hello" })
  })

  test("rejects an empty body without making a request", async () => {
    let requests = 0
    globalThis.fetch = async () => {
      requests += 1
      return Response.json({ result: {} })
    }
    const client = await connectDaemonClient({ name: "test", url: BASE })
    try {
      await assert.rejects(client.comment.issue({ repo: "org/repo", issueNumber: 1, body: "  " }))
    } finally {
      await client.close()
    }
    assert.equal(requests, 0)
  })
})
