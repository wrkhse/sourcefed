import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { fetchHttp, redactHeaders } from "@sourcefed/sdk"

const url = "https://example.test/feed"

describe("fetchHttp", () => {
  test("resolves a JSON body", async () => {
    const http = fetchHttp(async () => new Response(JSON.stringify({ ok: true })))

    assert.deepEqual(await http.json(url), { ok: true })
  })

  test("reports a status failure with its code", async () => {
    const http = fetchHttp(async () => new Response("slow down", { status: 429 }))

    await assert.rejects(http.json(url), { name: "HttpError", failure: "status", status: 429 })
  })

  test("reports a transport failure", async () => {
    const http = fetchHttp(async () => {
      throw new Error("socket closed")
    })

    await assert.rejects(http.json(url), { name: "HttpError", failure: "transport", message: "socket closed" })
  })

  test("reports a body that is not JSON", async () => {
    const http = fetchHttp(async () => new Response("<html>", { status: 200 }))

    await assert.rejects(http.json(url), { name: "HttpError", failure: "body" })
  })
})

describe("redactHeaders", () => {
  test("redacts secrets whatever their casing and leaves the rest", () => {
    assert.deepEqual(
      redactHeaders({ Accept: "application/json", AUTHORIZATION: "Bearer token", Cookie: "session=1" }),
      { accept: "application/json", authorization: "«redacted»", cookie: "«redacted»" },
    )
  })
})
