import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fetchHttp } from "@sourcefed/sdk";
import { GithubClient, resetGithubApi } from "./client.ts";
import { fetchJobLog } from "./logs.ts";
import { fetchPrData } from "./pr.ts";

const realFetch = globalThis.fetch;
const realToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = realToken;
  delete process.env.GH_TOKEN;
});

function client(): GithubClient {
  resetGithubApi();
  return GithubClient.open(
    "test-token",
    "m1",
    ["graphql", "rest"],
    false,
    fetchHttp(),
    () => new Date(),
  )!;
}

describe("GitHub direct API", () => {
  test("maps GraphQL pull request data into poll shapes", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                title: "Add navigate",
                state: "OPEN",
                mergeable: "CONFLICTING",
                mergeStateStatus: "DIRTY",
                reviews: {
                  nodes: [
                    {
                      databaseId: 7,
                      author: { login: "alice" },
                      state: "CHANGES_REQUESTED",
                      submittedAt: "2026-08-04T12:00:00Z",
                      body: "Fix it",
                    },
                  ],
                },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        name: "Lint",
                        conclusion: "failure",
                        detailsUrl:
                          "https://github.com/org/repo/actions/runs/42",
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const data = await fetchPrData(client(), "org/repo", 12);
    assert.deepEqual(data, {
      title: "Add navigate",
      reviews: [
        {
          id: 7,
          author: { login: "alice" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-08-04T12:00:00Z",
          body: "Fix it",
        },
      ],
      statusCheckRollup: [
        {
          name: "Lint",
          conclusion: "failure",
          detailsUrl: "https://github.com/org/repo/actions/runs/42",
        },
      ],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      state: "OPEN",
    });
  });

  test("throws when the GraphQL response reports errors", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "boom" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await assert.rejects(
      fetchPrData(client(), "org/repo", 12),
      /GitHub GraphQL: boom/,
    );
  });

  test("reads one job's log from the job-log endpoint", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response("hello from the failing job\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    assert.equal(
      await fetchJobLog(client(), "org/repo", "42"),
      "hello from the failing job\n",
    );
    assert.equal(
      requested,
      "https://api.github.com/repos/org/repo/actions/jobs/42/logs",
    );
  });

  test("skips job logs larger than the cap", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    globalThis.fetch = async () =>
      new Response(new Uint8Array(0), {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(11_000_000),
        },
      });

    assert.equal(await fetchJobLog(client(), "org/repo", "42"), undefined);
  });

  test("stops reading a job log that grows past the cap", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const chunk = new Uint8Array(1_000_000);
    let sent = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );

    assert.equal(await fetchJobLog(client(), "org/repo", "42"), undefined);
    assert.ok(sent <= 12, `read ${sent} chunks`);
  });
});
