import type { GoldenFixture } from "@sourcefed/sdk";

/** What the pre-SDK slack provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const SLACK_GOLDEN: GoldenFixture = {
  provider: "slack",
  recordedFrom: "0a1a5e7",
  base: "https://slack.com/api",
  cases: [
    {
      name: "thread-priming",
      now: "2026-11-18T12:00:00.000Z",
      build: {
        name: "thread",
        sourceType: "slack",
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
      cursor: null,
      replies: [
        {
          body: {
            ok: true,
            messages: [
              {
                ts: "1700000000.000100",
                user: "U1",
                text: "Parent",
              },
              {
                ts: "1700000100.000200",
                user: "U2",
                text: "first reply",
              },
            ],
            response_metadata: {
              next_cursor: "",
            },
          },
        },
        {
          body: {
            ok: true,
            members: [
              {
                id: "U1",
                name: "alice",
                real_name: "Alice",
              },
              {
                id: "U2",
                name: "bob",
                real_name: "Bob",
              },
            ],
            response_metadata: {
              next_cursor: "",
            },
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://slack.com/api/conversations.replies",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "channel=C123&ts=1700000000.000100&inclusive=false&limit=1000",
        },
        {
          method: "POST",
          url: "https://slack.com/api/users.list",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "limit=200",
        },
      ],
      source: {
        type: "slack",
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
      key: "slack:C123#1700000000.000100",
      label: "thread",
      detail: " C123",
      describe: "Slack C123 thread 1700000000.000100",
      icon: "󰒱",
      schema: {
        description:
          "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
        properties: {
          threadUrl: {
            type: "string",
            description: "Slack thread URL",
          },
          channelId: {
            type: "string",
            description:
              "Slack channel or DM ID; a DM ID without threadTs watches the whole DM",
          },
          threadTs: {
            type: "string",
            description: "Slack parent message timestamp",
          },
        },
        required: [],
      },
      events: [],
      cursorAfter: {
        primed: true,
        messageIds: ["1700000000.000100", "1700000100.000200"],
        latestTs: "1700000100.000200",
      },
      terminal: false,
    },
    {
      name: "thread-reply",
      now: "2026-11-18T12:01:00.000Z",
      build: {
        name: "thread",
        sourceType: "slack",
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
      cursor: {
        primed: true,
        messageIds: ["1700000000.000100", "1700000100.000200"],
        latestTs: "1700000100.000200",
      },
      replies: [
        {
          body: {
            ok: true,
            messages: [
              {
                ts: "1700000200.000300",
                user: "U1",
                text: "new reply",
              },
            ],
            response_metadata: {
              next_cursor: "",
            },
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://slack.com/api/conversations.replies",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "channel=C123&ts=1700000000.000100&inclusive=false&oldest=1700000100.000200&limit=1000",
        },
      ],
      source: {
        type: "slack",
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
      key: "slack:C123#1700000000.000100",
      label: "thread",
      detail: " C123",
      describe: "Slack C123 thread 1700000000.000100",
      icon: "󰒱",
      schema: {
        description:
          "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
        properties: {
          threadUrl: {
            type: "string",
            description: "Slack thread URL",
          },
          channelId: {
            type: "string",
            description:
              "Slack channel or DM ID; a DM ID without threadTs watches the whole DM",
          },
          threadTs: {
            type: "string",
            description: "Slack parent message timestamp",
          },
        },
        required: [],
      },
      events: [
        {
          source: {
            type: "slack",
            channelId: "C123",
            threadTs: "1700000000.000100",
          },
          kind: "message",
          id: "message:1700000200.000300",
          at: "2023-11-14T22:16:40.000Z",
          summary: "Slack thread message by Alice",
          body: "new reply",
          actionable: true,
        },
      ],
      cursorAfter: {
        primed: true,
        messageIds: [
          "1700000000.000100",
          "1700000100.000200",
          "1700000200.000300",
        ],
        latestTs: "1700000200.000300",
      },
      terminal: false,
    },
    {
      name: "dm-priming",
      now: "2026-11-18T12:02:00.000Z",
      build: {
        name: "dm",
        sourceType: "slack",
        channelId: "D999",
      },
      cursor: null,
      replies: [
        {
          body: {
            ok: true,
            messages: [
              {
                ts: "1700000400.000500",
                user: "U2",
                text: "older",
              },
            ],
            response_metadata: {
              next_cursor: "",
            },
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://slack.com/api/conversations.history",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "channel=D999&inclusive=false&limit=1000",
        },
      ],
      source: {
        type: "slack",
        channelId: "D999",
      },
      key: "slack:D999",
      label: "DM",
      detail: " D999",
      describe: "Slack DM D999",
      icon: "󰒱",
      schema: {
        description:
          "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
        properties: {
          threadUrl: {
            type: "string",
            description: "Slack thread URL",
          },
          channelId: {
            type: "string",
            description:
              "Slack channel or DM ID; a DM ID without threadTs watches the whole DM",
          },
          threadTs: {
            type: "string",
            description: "Slack parent message timestamp",
          },
        },
        required: [],
      },
      events: [],
      cursorAfter: {
        primed: true,
        messageIds: ["1700000400.000500"],
        latestTs: "1700000400.000500",
      },
      terminal: false,
    },
    {
      name: "dm-message",
      now: "2026-11-18T12:03:00.000Z",
      build: {
        name: "dm",
        sourceType: "slack",
        channelId: "D999",
      },
      cursor: {
        primed: true,
        messageIds: ["1700000400.000500"],
        latestTs: "1700000400.000500",
      },
      replies: [
        {
          body: {
            ok: true,
            messages: [
              {
                ts: "1700000500.000600",
                user: "U2",
                text: "a DM",
              },
            ],
            response_metadata: {
              next_cursor: "",
            },
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://slack.com/api/conversations.history",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "channel=D999&inclusive=false&oldest=1700000400.000500&limit=1000",
        },
      ],
      source: {
        type: "slack",
        channelId: "D999",
      },
      key: "slack:D999",
      label: "DM",
      detail: " D999",
      describe: "Slack DM D999",
      icon: "󰒱",
      schema: {
        description:
          "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
        properties: {
          threadUrl: {
            type: "string",
            description: "Slack thread URL",
          },
          channelId: {
            type: "string",
            description:
              "Slack channel or DM ID; a DM ID without threadTs watches the whole DM",
          },
          threadTs: {
            type: "string",
            description: "Slack parent message timestamp",
          },
        },
        required: [],
      },
      events: [
        {
          source: {
            type: "slack",
            channelId: "D999",
          },
          kind: "message",
          id: "message:1700000500.000600",
          at: "2023-11-14T22:21:40.000Z",
          summary: "Slack DM message by Bob",
          body: "a DM",
          actionable: true,
        },
      ],
      cursorAfter: {
        primed: true,
        messageIds: ["1700000400.000500", "1700000500.000600"],
        latestTs: "1700000500.000600",
      },
      terminal: false,
    },
    {
      name: "rate-limited",
      now: "2026-11-18T12:04:00.000Z",
      build: {
        name: "thread",
        sourceType: "slack",
        channelId: "C123",
        threadTs: "1700000900.000900",
      },
      cursor: null,
      replies: [
        {
          status: 429,
          headers: {
            "retry-after": "30",
          },
          body: {
            ok: false,
            error: "ratelimited",
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://slack.com/api/conversations.replies",
          headers: {
            authorization: "«redacted»",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "channel=C123&ts=1700000900.000900&inclusive=false&limit=1000",
        },
      ],
      source: {
        type: "slack",
        channelId: "C123",
        threadTs: "1700000900.000900",
      },
      key: "slack:C123#1700000900.000900",
      label: "thread",
      detail: " C123",
      describe: "Slack C123 thread 1700000900.000900",
      icon: "󰒱",
      schema: {
        description:
          "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
        properties: {
          threadUrl: {
            type: "string",
            description: "Slack thread URL",
          },
          channelId: {
            type: "string",
            description:
              "Slack channel or DM ID; a DM ID without threadTs watches the whole DM",
          },
          threadTs: {
            type: "string",
            description: "Slack parent message timestamp",
          },
        },
        required: [],
      },
      deferred: true,
    },
  ],
  webhook: {
    path: "/webhooks/slack",
    preferred: true,
    acknowledgeBeforeDelivery: true,
    configured: true,
    cases: [
      {
        name: "url-verification",
        now: "2026-11-18T12:05:00.000Z",
        headers: {
          "x-slack-request-timestamp": "1795003500",
          "x-slack-signature":
            "v0=e4ca3ad6a11a2f7238e2e3107aeede4184fa52214b8c2990eaab745c7eabc751",
        },
        body: '{"type":"url_verification","challenge":"abc123","token":"x"}',
        cursor: null,
        verified: true,
        challenge: {
          challenge: "abc123",
        },
      },
      {
        name: "thread-message",
        now: "2026-11-18T12:06:00.000Z",
        headers: {
          "x-slack-request-timestamp": "1795003560",
          "x-slack-signature":
            "v0=f0fbf5fb78ec000c4b547818c69f73a943f2f6b713a71d90f433a7f0c1fc31fb",
        },
        body: '{"type":"event_callback","event_id":"Ev01","event":{"type":"message","channel":"C123","thread_ts":"1700000000.000100","ts":"1700000300.000400","event_ts":"1700000300.000400","user":"U2","text":"from webhook"}}',
        cursor: {
          primed: true,
          messageIds: [
            "1700000000.000100",
            "1700000100.000200",
            "1700000200.000300",
          ],
          latestTs: "1700000200.000300",
        },
        verified: true,
        challenge: null,
        deliveryId: "Ev01",
        eventName: "slack",
        event: {
          source: {
            type: "slack",
            channelId: "C123",
            threadTs: "1700000000.000100",
          },
          kind: "message",
          id: "message:1700000300.000400",
          at: "2023-11-14T22:18:20.000Z",
          summary: "Slack thread message by U2",
          body: "from webhook\n\nSlack event: Ev01",
          actionable: true,
        },
        cursorAfter: {
          primed: true,
          messageIds: [
            "1700000000.000100",
            "1700000100.000200",
            "1700000200.000300",
            "1700000300.000400",
          ],
          latestTs: "1700000300.000400",
        },
      },
      {
        name: "stale",
        now: "2026-11-18T12:07:00.000Z",
        headers: {
          "x-slack-request-timestamp": "1795003020",
          "x-slack-signature":
            "v0=deefee63775c4487643293afcccab5942fcf0bd35cc73059f6cc7b62e6234cb1",
        },
        body: '{"type":"event_callback","event_id":"Ev03","event":{"type":"message","channel":"C123","thread_ts":"1700000000.000100","ts":"1700000350.000450","event_ts":"1700000350.000450","user":"U1","text":"too late"}}',
        cursor: null,
        verified: false,
      },
      {
        name: "dm-without-time",
        now: "2026-11-18T12:08:00.000Z",
        headers: {
          "x-slack-request-timestamp": "1795003680",
          "x-slack-signature":
            "v0=5488d3b61bf7693395bf77d9286f0941fb2d004ee0f4c0f2d17661c7e8da0727",
        },
        body: '{"type":"event_callback","event_id":"Ev02","event":{"type":"message","channel":"D999","user":"U2","text":"no timestamps"}}',
        cursor: null,
        verified: true,
        challenge: null,
        deliveryId: "Ev02",
        eventName: "slack",
        event: {
          source: {
            type: "slack",
            channelId: "D999",
          },
          kind: "message",
          at: "2026-11-18T12:08:00.000Z",
          summary: "Slack DM message by U2",
          body: "no timestamps\n\nSlack event: Ev02",
          actionable: true,
        },
        cursorAfter: {
          primed: true,
          messageIds: [],
        },
      },
    ],
  },
};
