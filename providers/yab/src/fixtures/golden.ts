import type { GoldenFixture } from "@sourcefed/sdk"

/** What the pre-SDK yab provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const YAB_GOLDEN: GoldenFixture = {
  "provider": "yab",
  "recordedFrom": "0a1a5e7",
  "base": "https://mail.google.com",
  "cases": [
    {
      "name": "priming",
      "now": "2026-11-18T12:00:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": null,
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "200 · application/atom+xml · https://mail.google.com/mail/u/0/feed/atom\n\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed version=\"0.3\" xmlns=\"http://purl.org/atom/ns#\"><title>Gmail - Inbox</title><entry><title>Your order has shipped</title><summary>Your order has shipped — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1002&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T11:00:00Z</modified><issued>2026-11-18T11:00:00Z</issued><id>tag:gmail.google.com,2004:1002</id><author><name>Amazon</name><email>ship@amazon.com</email></author></entry><entry><title>Weekly digest</title><summary>Weekly digest — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1001&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T10:00:00Z</modified><issued>2026-11-18T10:00:00Z</issued><id>tag:gmail.google.com,2004:1001</id><author><name>Medium</name><email>noreply@medium.com</email></author></entry></feed>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "events": [],
      "cursorAfter": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:1002",
          "tag:gmail.google.com,2004:1001"
        ]
      },
      "terminal": false
    },
    {
      "name": "new-entry",
      "now": "2026-11-18T12:01:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:1002",
          "tag:gmail.google.com,2004:1001"
        ]
      },
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "200 · application/atom+xml · https://mail.google.com/mail/u/0/feed/atom\n\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed version=\"0.3\" xmlns=\"http://purl.org/atom/ns#\"><title>Gmail - Inbox</title><entry><title>Lunch on Friday?</title><summary>Lunch on Friday? — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1003&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T12:00:30Z</modified><issued>2026-11-18T12:00:30Z</issued><id>tag:gmail.google.com,2004:1003</id><author><name>Asha</name><email>asha@example.com</email></author></entry><entry><title>Your order has shipped</title><summary>Your order has shipped — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1002&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T11:00:00Z</modified><issued>2026-11-18T11:00:00Z</issued><id>tag:gmail.google.com,2004:1002</id><author><name>Amazon</name><email>ship@amazon.com</email></author></entry><entry><title>Weekly digest</title><summary>Weekly digest — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1001&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T10:00:00Z</modified><issued>2026-11-18T10:00:00Z</issued><id>tag:gmail.google.com,2004:1001</id><author><name>Medium</name><email>noreply@medium.com</email></author></entry></feed>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "events": [
        {
          "source": {
            "type": "yab",
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "space": "Personal"
          },
          "kind": "entry",
          "id": "entry:tag:gmail.google.com,2004:1003",
          "at": "2026-11-18T12:00:30.000Z",
          "summary": "Yab feed entry from Asha <asha@example.com>: Lunch on Friday?",
          "body": "Lunch on Friday? — preview\n\nhttps://mail.google.com/mail/u/0?account_id=me@example.com&message_id=1003&view=conv",
          "actionable": true
        }
      ],
      "cursorAfter": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:1002",
          "tag:gmail.google.com,2004:1001",
          "tag:gmail.google.com,2004:1003"
        ]
      },
      "terminal": false
    },
    {
      "name": "undated-entry",
      "now": "2026-11-18T12:02:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:1002",
          "tag:gmail.google.com,2004:1001",
          "tag:gmail.google.com,2004:1003"
        ]
      },
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "200 · application/atom+xml · https://mail.google.com/mail/u/0/feed/atom\n\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed version=\"0.3\" xmlns=\"http://purl.org/atom/ns#\"><title>Gmail - Inbox</title><entry><title>Undated note</title><summary>Undated note — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1004&amp;view=conv\" type=\"text/html\"/><id>tag:gmail.google.com,2004:1004</id><author><name>Ravi</name><email>ravi@example.com</email></author></entry><entry><title>Lunch on Friday?</title><summary>Lunch on Friday? — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1003&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T12:00:30Z</modified><issued>2026-11-18T12:00:30Z</issued><id>tag:gmail.google.com,2004:1003</id><author><name>Asha</name><email>asha@example.com</email></author></entry><entry><title>Your order has shipped</title><summary>Your order has shipped — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1002&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T11:00:00Z</modified><issued>2026-11-18T11:00:00Z</issued><id>tag:gmail.google.com,2004:1002</id><author><name>Amazon</name><email>ship@amazon.com</email></author></entry><entry><title>Weekly digest</title><summary>Weekly digest — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=1001&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T10:00:00Z</modified><issued>2026-11-18T10:00:00Z</issued><id>tag:gmail.google.com,2004:1001</id><author><name>Medium</name><email>noreply@medium.com</email></author></entry></feed>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "events": [
        {
          "source": {
            "type": "yab",
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "space": "Personal"
          },
          "kind": "entry",
          "id": "entry:tag:gmail.google.com,2004:1004",
          "at": "2026-11-18T12:02:00.000Z",
          "summary": "Yab feed entry from Ravi <ravi@example.com>: Undated note",
          "body": "Undated note — preview\n\nhttps://mail.google.com/mail/u/0?account_id=me@example.com&message_id=1004&view=conv",
          "actionable": true
        }
      ],
      "cursorAfter": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:1002",
          "tag:gmail.google.com,2004:1001",
          "tag:gmail.google.com,2004:1003",
          "tag:gmail.google.com,2004:1004"
        ]
      },
      "terminal": false
    },
    {
      "name": "filter-priming",
      "now": "2026-11-18T12:03:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal",
        "match": "interview"
      },
      "cursor": null,
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "200 · application/atom+xml · https://mail.google.com/mail/u/0/feed/atom\n\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed version=\"0.3\" xmlns=\"http://purl.org/atom/ns#\"><title>Gmail - Inbox</title><entry><title>Newsletter</title><summary>Newsletter — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=2001&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T09:00:00Z</modified><issued>2026-11-18T09:00:00Z</issued><id>tag:gmail.google.com,2004:2001</id><author><name>Substack</name><email>no-reply@substack.com</email></author></entry></feed>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal",
        "match": "interview"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom · filtered",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "events": [],
      "cursorAfter": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:2001"
        ]
      },
      "terminal": false
    },
    {
      "name": "filter",
      "now": "2026-11-18T12:04:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal",
        "match": "interview"
      },
      "cursor": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:2001"
        ]
      },
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "200 · application/atom+xml · https://mail.google.com/mail/u/0/feed/atom\n\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><feed version=\"0.3\" xmlns=\"http://purl.org/atom/ns#\"><title>Gmail - Inbox</title><entry><title>Your weekly summary</title><summary>Your weekly summary — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=2003&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T12:03:30Z</modified><issued>2026-11-18T12:03:30Z</issued><id>tag:gmail.google.com,2004:2003</id><author><name>GitHub</name><email>noreply@github.com</email></author></entry><entry><title>Interview for Staff Engineer</title><summary>Interview for Staff Engineer — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=2002&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T12:03:00Z</modified><issued>2026-11-18T12:03:00Z</issued><id>tag:gmail.google.com,2004:2002</id><author><name>Postman</name><email>talent@postman.com</email></author></entry><entry><title>Newsletter</title><summary>Newsletter — preview</summary><link rel=\"alternate\" href=\"https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=2001&amp;view=conv\" type=\"text/html\"/><modified>2026-11-18T09:00:00Z</modified><issued>2026-11-18T09:00:00Z</issued><id>tag:gmail.google.com,2004:2001</id><author><name>Substack</name><email>no-reply@substack.com</email></author></entry></feed>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal",
        "match": "interview"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom · filtered",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "events": [
        {
          "source": {
            "type": "yab",
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "space": "Personal",
            "match": "interview"
          },
          "kind": "entry",
          "id": "entry:tag:gmail.google.com,2004:2002",
          "at": "2026-11-18T12:03:00.000Z",
          "summary": "Yab feed entry from Postman <talent@postman.com>: Interview for Staff Engineer",
          "body": "Interview for Staff Engineer — preview\n\nhttps://mail.google.com/mail/u/0?account_id=me@example.com&message_id=2002&view=conv",
          "actionable": true
        }
      ],
      "cursorAfter": {
        "primed": true,
        "seenIds": [
          "tag:gmail.google.com,2004:2001",
          "tag:gmail.google.com,2004:2003",
          "tag:gmail.google.com,2004:2002"
        ]
      },
      "terminal": false
    },
    {
      "name": "sign-in",
      "now": "2026-11-18T12:05:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": null,
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "text": "401 · text/html · https://mail.google.com/mail/u/0/feed/atom\n\n<html></html>"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "error": "yab fetch of mail.google.com answered 401; sign in to the site in Yab"
    },
    {
      "name": "tool-failure",
      "now": "2026-11-18T12:06:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": null,
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "isError": true,
          "text": "no such space"
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "error": "Yab reported the fetch failed"
    },
    {
      "name": "rpc-error",
      "now": "2026-11-18T12:07:00.000Z",
      "build": {
        "name": "mail",
        "sourceType": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "cursor": null,
      "replies": [],
      "requests": [],
      "mcpReplies": [
        {
          "error": {
            "code": -32000,
            "message": "boom"
          }
        }
      ],
      "mcpCalls": [
        {
          "tool": "fetch",
          "arguments": {
            "url": "https://mail.google.com/mail/u/0/feed/atom",
            "html": true,
            "space": "Personal"
          }
        }
      ],
      "source": {
        "type": "yab",
        "url": "https://mail.google.com/mail/u/0/feed/atom",
        "space": "Personal"
      },
      "key": "yab:Personal:https://mail.google.com/mail/u/0/feed/atom",
      "label": "mail.google.com",
      "detail": " mail.google.com/mail/u/0/feed/atom",
      "describe": "Yab feed mail.google.com/mail/u/0/feed/atom (Personal)",
      "icon": "󰖟",
      "schema": {
        "description": "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
        "properties": {
          "url": {
            "type": "string",
            "description": "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom"
          },
          "space": {
            "type": "string",
            "description": "Yab space whose sign-ins to use; omit to use wherever the site is signed in"
          },
          "match": {
            "type": "string",
            "description": "Case-insensitive regex; only entries whose title, summary or author match are delivered"
          },
          "exclude": {
            "type": "string",
            "description": "Case-insensitive regex; entries that match are skipped"
          }
        },
        "required": [
          "url"
        ]
      },
      "error": "Yab answered with an error (code -32000)"
    }
  ]
}
