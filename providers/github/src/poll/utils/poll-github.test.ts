import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { toMonitorEvent } from "@sourcefed/core";
import { fetchHttp } from "@sourcefed/sdk";
import { resetGithubApi } from "../../api";
import { pollGithub } from "./poll-github.ts";

// No test calls GitHub: fetch is replaced by a fake GitHub.
const realFetch = globalThis.fetch;
const realToken = process.env.GITHUB_TOKEN;
const realGhToken = process.env.GH_TOKEN;
const SOURCE = { type: "github", repo: "org/repo", prNumber: 12 };
const NOW = "2026-11-18T12:00:00.000Z";
const now = () => new Date(NOW);

type FakeGithub = { title?: string; mergeable: string };

// Serves the pull request's GraphQL data and its two empty comment lists.
function installGithub(title: string | undefined): FakeGithub {
  const fake: FakeGithub = { title, mergeable: "MERGEABLE" };
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname !== "/graphql") return Response.json([]);
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            title: fake.title,
            state: "OPEN",
            mergeable: fake.mergeable,
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
            statusCheckRollup: {
              contexts: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      },
    });
  }) as typeof fetch;
  return fake;
}

// Two polls: the first primes the history, and the second reports one merge conflict.
async function eventsAfterConflict(
  fake: FakeGithub,
): ReturnType<typeof pollGithub> {
  const first = await pollGithub(
    fetchHttp(),
    now,
    SOURCE.repo,
    SOURCE.prNumber,
    undefined,
    "m1",
  );
  if ("deferred" in first) assert.fail("the first poll is deferred");
  fake.mergeable = "CONFLICTING";
  return pollGithub(
    fetchHttp(),
    now,
    SOURCE.repo,
    SOURCE.prNumber,
    first.cursor,
    "m1",
  );
}

describe("GitHub pull request poll subjects", () => {
  beforeEach(() => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    resetGithubApi();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreToken("GITHUB_TOKEN", realToken);
    restoreToken("GH_TOKEN", realGhToken);
    resetGithubApi();
  });

  test("an event carries the title as its subject, trimmed, and keeps it as a monitor event", async () => {
    const fake = installGithub("  feat(cli): add navigate ");
    const result = await eventsAfterConflict(fake);
    if ("deferred" in result) assert.fail("the second poll is deferred");

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.at, NOW);
    const subject = {
      type: "github-pull-request",
      key: "org/repo#12",
      repo: "org/repo",
      number: 12,
      title: "feat(cli): add navigate",
    };
    assert.deepEqual(result.events[0]!.subject, subject);
    assert.deepEqual(
      toMonitorEvent(result.events[0]!, SOURCE).subject,
      subject,
    );
  });

  test("an empty title omits the title property", async () => {
    const fake = installGithub("   ");
    const result = await eventsAfterConflict(fake);
    if ("deferred" in result) assert.fail("the second poll is deferred");

    assert.deepEqual(result.events[0]!.subject, {
      type: "github-pull-request",
      key: "org/repo#12",
      repo: "org/repo",
      number: 12,
    });
    assert.equal("title" in result.events[0]!.subject!, false);
  });

  test("a title longer than 300 characters is cut to 300", async () => {
    const fake = installGithub("x".repeat(400));
    const result = await eventsAfterConflict(fake);
    if ("deferred" in result) assert.fail("the second poll is deferred");

    assert.equal(result.events[0]!.subject?.title, "x".repeat(300));
  });
});

function restoreToken(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
