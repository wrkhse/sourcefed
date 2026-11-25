import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MonitorRecord, MonitorSource } from "@sourcefed/core";
import type { SlackSourceRecord } from "./types";
import { SlackMonitor } from "./index";
import { parseSlackReadResult } from "./poll";
import {
  parseSlackWebhook,
  slackSignature,
  validSlackSignature,
} from "./webhook";
import { updateSlackCursor } from "./webhook/utils/update-slack-cursor.ts";

process.env.SOURCEFED_SLACK_SIGNING_SECRET ??= "test-signing-secret";

// The host's clock: a signature's age is judged by it, and a message without a time is stamped with it.
const NOW = "2026-11-18T12:00:00.000Z";
const now = () => new Date(NOW);
const nowSec = Date.parse(NOW) / 1000;

describe("Slack monitor source", () => {
  test("uses one instantiated source object from the registry", () => {
    const monitor = SlackMonitor;
    const source: SlackSourceRecord = {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    };
    assert.deepEqual(monitor.validateSource(source), source);
  });

  test("parses a Slack thread URL with an explicit parent timestamp", () => {
    const source = SlackMonitor.build({
      threadUrl:
        "https://workspace.slack.com/archives/D123456/p1712345680000001?thread_ts=1712345678.901234",
    });

    assert.deepEqual(source, {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    });
  });

  test("converts a parent message path timestamp when no query timestamp exists", () => {
    const source = SlackMonitor.build({
      threadUrl:
        "https://workspace.slack.com/archives/D123456/p1712345678901234",
    });

    assert.deepEqual(source, {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    });
  });

  test("builds a whole-DM monitor from a DM conversation ID", () => {
    assert.deepEqual(SlackMonitor.build({ channelId: "D123456" }), {
      type: "slack",
      channelId: "D123456",
    });
  });

  test("requires a thread timestamp for non-DM conversations", () => {
    assert.deepEqual(SlackMonitor.build({ channelId: "C123456" }), {
      error: "threadTs is required unless channelId is a Slack DM ID",
    });
    assert.deepEqual(
      SlackMonitor.build({ threadUrl: "https://workspace.slack.com/client" }),
      {
        error:
          "threadUrl does not contain a Slack channel and thread timestamp",
      },
    );
  });

  test("prefers webhook delivery when the signing secret is available", () => {
    const source: MonitorSource = {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    };
    const monitor = SlackMonitor;
    assert.equal(monitor.initialDelivery(source), "webhook");
    assert.equal(monitor.webhook?.preferred, true);
  });
});

describe("Slack webhook events", () => {
  test("accepts only new replies in a thread", () => {
    const event = parseSlackWebhook(
      {
        type: "event_callback",
        event: {
          type: "message",
          channel: "D123456",
          thread_ts: "1712345678.901234",
          ts: "1712345680.000001",
          user: "U123",
          text: "A new reply",
        },
      },
      "slack",
      "Ev123",
      now,
    );

    assert.deepEqual(event?.source, {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    });
    assert.ok(event?.body?.includes("A new reply") === true);
    assert.equal(event?.at, new Date(1712345680.000001 * 1000).toISOString());
  });

  test("accepts top-level DM messages", () => {
    const event = parseSlackWebhook(
      {
        type: "event_callback",
        event: {
          type: "message",
          channel: "D123456",
          channel_type: "im",
          ts: "1712345678.901234",
          user: "U123",
          text: "A direct message",
        },
      },
      "slack",
      "Ev1",
      now,
    );

    assert.deepEqual(event?.source, { type: "slack", channelId: "D123456" });
    assert.equal(event?.summary, "Slack DM message by U123");
  });

  test("ignores top-level channel messages and non-message events", () => {
    assert.equal(
      parseSlackWebhook(
        {
          type: "event_callback",
          event: {
            type: "message",
            channel: "C123456",
            ts: "1712345678.901234",
          },
        },
        "slack",
        "Ev1",
        now,
      ),
      undefined,
    );
    assert.equal(
      parseSlackWebhook(
        {
          type: "event_callback",
          event: { type: "reaction_added", item: { channel: "D123456" } },
        },
        "slack",
        "Ev2",
        now,
      ),
      undefined,
    );
  });
});

describe("Slack poll cursor", () => {
  test("primes existing history and emits only later replies", () => {
    const initial = parseSlackReadResult(
      {
        messages: [
          { ts: "1712345678.901234", text: "Parent" },
          {
            ts: "1712345680.000001",
            thread_ts: "1712345678.901234",
            user: "U123",
            text: "Existing reply",
          },
        ],
        users: [{ id: "U123", real_name: "Test User" }],
      },
      undefined,
      "thread",
      now,
    );

    assert.equal(initial.events.length, 0);
    assert.equal(initial.cursor.primed, true);
    assert.deepEqual(initial.cursor.messageIds, [
      "1712345678.901234",
      "1712345680.000001",
    ]);

    const next = parseSlackReadResult(
      {
        messages: [
          { ts: "1712345678.901234", text: "Parent" },
          {
            ts: "1712345680.000001",
            thread_ts: "1712345678.901234",
            user: "U123",
            text: "Existing reply",
          },
          {
            ts: "1712345690.000001",
            thread_ts: "1712345678.901234",
            user: "U123",
            text: "New reply",
          },
        ],
        users: [{ id: "U123", real_name: "Test User" }],
      },
      initial.cursor,
      "thread",
      now,
    );

    assert.equal(next.events.length, 1);
    assert.partialDeepStrictEqual(next.events[0], {
      summary: "Slack thread message by Test User",
      body: "New reply",
      actionable: true,
    });
  });

  test("labels whole-DM polling events", () => {
    const initial = parseSlackReadResult(
      { messages: [{ ts: "1712345678.901234", text: "Existing" }] },
      undefined,
      "DM",
      now,
    );
    const next = parseSlackReadResult(
      {
        messages: [
          { ts: "1712345678.901234", text: "Existing" },
          { ts: "1712345680.000001", user: "U123", text: "New DM" },
        ],
        users: [{ id: "U123", real_name: "Test User" }],
      },
      initial.cursor,
      "DM",
      now,
    );

    assert.equal(next.events[0]?.summary, "Slack DM message by Test User");
  });

  test("keeps messages after the last webhook event during poll fallback", () => {
    const cursor = updateSlackCursor(
      {
        source: {
          type: "slack",
          channelId: "D123456",
          threadTs: "1712345678.901234",
        },
        kind: "message",
        id: "message:1712345690.000001",
        at: "2024-04-05T12:34:50.000Z",
        summary: "webhook message",
        actionable: true,
      },
      undefined,
    );

    const result = parseSlackReadResult(
      {
        messages: [
          { ts: "1712345678.901234", text: "Parent" },
          { ts: "1712345680.000001", text: "Old reply" },
          { ts: "1712345690.000001", text: "Webhook reply" },
          { ts: "1712345695.000001", text: "Outage reply" },
        ],
      },
      cursor,
      "thread",
      now,
    );

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].body, "Outage reply");
  });
});

describe("Slack request verification", () => {
  test("accepts a current correctly signed request", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = nowSec.toString();
    const request = new Request("http://localhost/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(
          body,
          timestamp,
          "test-signing-secret",
        ),
      },
    });

    assert.equal(
      validSlackSignature(body, request, now, "test-signing-secret"),
      true,
    );
  });

  test("rejects stale requests", () => {
    const body = "{}";
    const timestamp = (nowSec - 301).toString();
    const request = new Request("http://localhost/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(
          body,
          timestamp,
          "test-signing-secret",
        ),
      },
    });

    assert.equal(
      validSlackSignature(body, request, now, "test-signing-secret"),
      false,
    );
  });
});

describe("transport recovery", () => {
  const monitor: MonitorRecord = {
    id: "m-test",
    name: "Slack test",
    source: {
      type: "slack",
      channelId: "D123456",
      threadTs: "1712345678.901234",
    },
    delivery: "poll",
    target: { kind: "test-session", id: "session-test" },
    pollIntervalSec: 60,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursors: { __webhookHeartbeatAt: Date.now() },
  };

  test("recovers from polling to a healthy webhook", () => {
    assert.equal(SlackMonitor.resolveDelivery(monitor), "webhook");
  });

  test("falls back to polling when the webhook heartbeat is stale", () => {
    const stale: MonitorRecord = {
      ...monitor,
      delivery: "webhook",
      cursors: { __webhookHeartbeatAt: Date.now() - 120_000 },
    };
    assert.equal(SlackMonitor.resolveDelivery(stale), "poll");
  });
});
