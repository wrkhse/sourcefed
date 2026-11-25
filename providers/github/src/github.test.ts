import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseGithubWebhook } from "./webhook";
import { githubPullRequestNumber } from "./webhook/utils/pull-request-number.ts";

// The host's clock, the time an event falls back to when its payload names none.
const NOW = "2026-11-18T12:00:00.000Z";
const now = () => new Date(NOW);

describe("GitHub webhook events", () => {
  test("extracts pull request numbers from check payloads", () => {
    assert.equal(
      githubPullRequestNumber(
        { check_run: { pull_requests: [{ number: 1671 }] } },
        "check_run",
      ),
      1671,
    );
    assert.equal(
      githubPullRequestNumber(
        { check_suite: { pull_requests: [{ number: 1671 }] } },
        "check_suite",
      ),
      1671,
    );
  });

  test("routes check-run events through their pull request association", () => {
    const event = parseGithubWebhook(
      {
        action: "completed",
        repository: {
          full_name: "example-org/example-repo",
          updated_at: "2026-08-04T12:00:00.000Z",
        },
        check_run: {
          name: "Lint",
          conclusion: "failure",
          pull_requests: [{ number: 1671 }],
        },
        sender: { login: "github-actions[bot]" },
      },
      "check_run",
      "delivery-1",
      now,
    );

    assert.partialDeepStrictEqual(event, {
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 1671,
      },
      kind: "ci",
      actionable: true,
    });
  });

  test("routes check-suite events through their pull request association", () => {
    const event = parseGithubWebhook(
      {
        action: "completed",
        repository: { full_name: "example-org/example-repo" },
        check_suite: {
          conclusion: "success",
          pull_requests: [{ number: 1671 }],
        },
        sender: { login: "github-actions[bot]" },
      },
      "check_suite",
      "delivery-2",
      now,
    );

    assert.partialDeepStrictEqual(event, {
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 1671,
      },
      kind: "ci",
      actionable: false,
    });
  });

  test("treats a closed unmerged pull request as terminal", () => {
    const event = parseGithubWebhook(
      {
        action: "closed",
        repository: { full_name: "example-org/example-repo" },
        pull_request: { number: 1671, merged: false },
        sender: { login: "someone" },
      },
      "pull_request",
      "delivery-3",
      now,
    );

    assert.partialDeepStrictEqual(event, {
      kind: "closed",
      id: "pr:CLOSED",
      at: NOW,
      terminal: true,
    });
  });

  test("ignores automated pull request edits", () => {
    const event = parseGithubWebhook(
      {
        action: "edited",
        repository: { full_name: "example-org/example-repo" },
        pull_request: { number: 1678 },
        sender: { login: "github-actions[bot]" },
      },
      "pull_request",
      "delivery-4",
      now,
    );

    assert.equal(event, undefined);
  });

  test("ignores empty pull request reviews", () => {
    const event = parseGithubWebhook(
      {
        action: "submitted",
        repository: { full_name: "example-org/example-repo" },
        pull_request: { number: 1678 },
        review: { id: 42, state: "commented", body: "" },
        sender: { login: "claude[bot]" },
      },
      "pull_request_review",
      "delivery-5",
      now,
    );

    assert.equal(event, undefined);
  });

  test("carries a pull request's title as the event's subject", () => {
    const event = parseGithubWebhook(
      {
        action: "opened",
        repository: { full_name: "example-org/example-repo" },
        pull_request: { number: 1671, title: "  Add navigate " },
        sender: { login: "someone" },
      },
      "pull_request",
      "delivery-7",
      now,
    );

    assert.deepEqual(event?.subject, {
      type: "github-pull-request",
      key: "example-org/example-repo#1671",
      repo: "example-org/example-repo",
      number: 1671,
      title: "Add navigate",
    });
  });

  test("carries an issue comment's pull request title as the event's subject", () => {
    const event = parseGithubWebhook(
      {
        action: "created",
        repository: { full_name: "example-org/example-repo" },
        issue: { number: 1672, title: "Fix the tick race" },
        comment: { id: 1, body: "Please bound it." },
        sender: { login: "someone" },
      },
      "issue_comment",
      "delivery-8",
      now,
    );

    assert.deepEqual(event?.subject, {
      type: "github-pull-request",
      key: "example-org/example-repo#1672",
      repo: "example-org/example-repo",
      number: 1672,
      title: "Fix the tick race",
    });
  });

  test("keeps review content without delivery metadata", () => {
    const event = parseGithubWebhook(
      {
        action: "submitted",
        repository: { full_name: "example-org/example-repo" },
        pull_request: { number: 1678 },
        review: {
          id: 43,
          state: "commented",
          body: "Please update the assertion.",
        },
        sender: { login: "claude[bot]" },
      },
      "pull_request_review",
      "delivery-6",
      now,
    );

    assert.partialDeepStrictEqual(event, {
      body: "Please update the assertion.",
    });
    assert.ok(event?.body?.includes("Webhook delivery") === false);
  });
});
