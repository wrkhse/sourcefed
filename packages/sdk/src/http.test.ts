import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchHttp, redactHeaders } from "@sourcefed/sdk";

const url = "https://example.test/feed";

describe("fetchHttp", () => {
  test("resolves a JSON body", async () => {
    const http = fetchHttp(
      async () => new Response(JSON.stringify({ ok: true })),
    );

    assert.deepEqual(await http.json(url), { ok: true });
  });

  test("reports a status failure with its code", async () => {
    const http = fetchHttp(
      async () => new Response("slow down", { status: 429 }),
    );

    await assert.rejects(http.json(url), {
      name: "HttpError",
      failure: "status",
      status: 429,
    });
  });

  test("reports a transport failure", async () => {
    const http = fetchHttp(async () => {
      throw new Error("socket closed");
    });

    await assert.rejects(http.json(url), {
      name: "HttpError",
      failure: "transport",
      message: "socket closed",
    });
  });

  test("reports a body that is not JSON", async () => {
    const http = fetchHttp(async () => new Response("<html>", { status: 200 }));

    await assert.rejects(http.json(url), {
      name: "HttpError",
      failure: "body",
    });
  });

  test("fetch passes the whole request through and answers with the upstream's reply", async () => {
    const signal = new AbortController().signal;
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const reply = new Response(null, {
      status: 304,
      headers: { etag: 'W/"a"' },
    });
    const http = fetchHttp(async (input, init) => {
      sent.push({ url: String(input), init });
      return reply;
    });

    const response = await http.fetch(url, {
      method: "POST",
      headers: { accept: "application/json" },
      body: "{}",
      signal,
    });

    assert.equal(response, reply);
    assert.equal(response.status, 304);
    assert.deepEqual(sent, [
      {
        url,
        init: {
          method: "POST",
          headers: { accept: "application/json" },
          body: "{}",
          signal,
        },
      },
    ]);
  });

  test("fetch rejects with the transport's own error", async () => {
    const failure = new TypeError("fetch failed");
    const http = fetchHttp(async () => {
      throw failure;
    });

    await assert.rejects(http.fetch(url), (error) => error === failure);
  });

  test("without an argument it uses the fetch in place when the request is made", async () => {
    const original = globalThis.fetch;
    const http = fetchHttp();

    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ replaced: true }));

      assert.deepEqual(await http.json(url), { replaced: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("redactHeaders", () => {
  test("redacts secrets whatever their casing and leaves the rest", () => {
    assert.deepEqual(
      redactHeaders({
        Accept: "application/json",
        AUTHORIZATION: "Bearer token",
        Cookie: "session=1",
      }),
      {
        accept: "application/json",
        authorization: "«redacted»",
        cookie: "«redacted»",
      },
    );
  });
});
