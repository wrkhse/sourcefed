import type { GoldenFixture } from "@sourcefed/sdk"

/** What the pre-SDK github-issues provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const GITHUB_ISSUES_GOLDEN: GoldenFixture = {
  "provider": "github-issues",
  "recordedFrom": "0a1a5e7",
  "base": "https://api.github.com",
  "now": "2026-11-18T12:00:00.000Z",
  "cases": [
    {
      "name": "priming",
      "build": {
        "name": "agent issues",
        "sourceType": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "cursor": null,
      "replies": [
        {
          "status": 200,
          "headers": {
            "etag": "W/\"a\""
          },
          "body": [
            {
              "number": 48,
              "title": "Issue 48",
              "html_url": "https://github.com/example-org/example-repo/issues/48",
              "state": "open",
              "labels": [
                {
                  "name": "agent"
                }
              ]
            },
            {
              "number": 49,
              "title": "Issue 49",
              "html_url": "https://github.com/example-org/example-repo/issues/49",
              "state": "open",
              "labels": [
                {
                  "name": "agent"
                }
              ]
            },
            {
              "number": 50,
              "title": "Issue 50",
              "html_url": "https://github.com/example-org/example-repo/pull/50",
              "state": "open",
              "labels": [
                {
                  "name": "agent"
                }
              ],
              "pull_request": {
                "html_url": "https://github.com/example-org/example-repo/pull/50"
              }
            }
          ]
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://api.github.com/repos/example-org/example-repo/issues?state=open&labels=agent&per_page=100",
          "headers": {
            "authorization": "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "accept": "application/vnd.github+json"
          }
        }
      ],
      "source": {
        "type": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "key": "github-issues:example-org/example-repo:agent:::",
      "label": "agent",
      "detail": " example-org/example-repo · label agent",
      "describe": "GitHub issues in example-org/example-repo with label agent",
      "icon": "󰊤",
      "schema": {
        "description": "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "repo": {
            "type": "string",
            "description": "GitHub owner/name, e.g. owner/repository"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "description": "Labels an issue must all carry"
          },
          "assignee": {
            "type": "string",
            "description": "Only issues assigned to this login"
          },
          "author": {
            "type": "string",
            "description": "Only issues opened by this login"
          },
          "query": {
            "type": "string",
            "description": "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "repo",
          "labels"
        ]
      },
      "events": [],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "example-org/example-repo#48",
          "example-org/example-repo#49"
        ],
        "overLimit": false,
        "etag": "W/\"a\""
      },
      "terminal": false
    },
    {
      "name": "not-modified",
      "build": {
        "name": "agent issues",
        "sourceType": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "cursor": {
        "primed": true,
        "keys": [
          "example-org/example-repo#48",
          "example-org/example-repo#49"
        ],
        "overLimit": false,
        "etag": "W/\"a\""
      },
      "replies": [
        {
          "status": 304,
          "headers": {
            "etag": "W/\"a\""
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://api.github.com/repos/example-org/example-repo/issues?state=open&labels=agent&per_page=100",
          "headers": {
            "authorization": "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "accept": "application/vnd.github+json",
            "if-none-match": "W/\"a\""
          }
        }
      ],
      "source": {
        "type": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "key": "github-issues:example-org/example-repo:agent:::",
      "label": "agent",
      "detail": " example-org/example-repo · label agent",
      "describe": "GitHub issues in example-org/example-repo with label agent",
      "icon": "󰊤",
      "schema": {
        "description": "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "repo": {
            "type": "string",
            "description": "GitHub owner/name, e.g. owner/repository"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "description": "Labels an issue must all carry"
          },
          "assignee": {
            "type": "string",
            "description": "Only issues assigned to this login"
          },
          "author": {
            "type": "string",
            "description": "Only issues opened by this login"
          },
          "query": {
            "type": "string",
            "description": "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "repo",
          "labels"
        ]
      },
      "events": [],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "example-org/example-repo#48",
          "example-org/example-repo#49"
        ],
        "overLimit": false,
        "etag": "W/\"a\""
      },
      "terminal": false
    },
    {
      "name": "change",
      "build": {
        "name": "agent issues",
        "sourceType": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "cursor": {
        "primed": true,
        "keys": [
          "example-org/example-repo#48",
          "example-org/example-repo#49"
        ],
        "overLimit": false,
        "etag": "W/\"a\""
      },
      "replies": [
        {
          "status": 200,
          "headers": {
            "etag": "W/\"b\""
          },
          "body": [
            {
              "number": 49,
              "title": "Issue 49",
              "html_url": "https://github.com/example-org/example-repo/issues/49",
              "state": "open",
              "labels": [
                {
                  "name": "agent"
                }
              ]
            },
            {
              "number": 51,
              "title": "Issue 51",
              "html_url": "https://github.com/example-org/example-repo/issues/51",
              "state": "open",
              "labels": [
                {
                  "name": "agent"
                }
              ]
            }
          ]
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://api.github.com/repos/example-org/example-repo/issues?state=open&labels=agent&per_page=100",
          "headers": {
            "authorization": "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "accept": "application/vnd.github+json",
            "if-none-match": "W/\"a\""
          }
        }
      ],
      "source": {
        "type": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "key": "github-issues:example-org/example-repo:agent:::",
      "label": "agent",
      "detail": " example-org/example-repo · label agent",
      "describe": "GitHub issues in example-org/example-repo with label agent",
      "icon": "󰊤",
      "schema": {
        "description": "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "repo": {
            "type": "string",
            "description": "GitHub owner/name, e.g. owner/repository"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "description": "Labels an issue must all carry"
          },
          "assignee": {
            "type": "string",
            "description": "Only issues assigned to this login"
          },
          "author": {
            "type": "string",
            "description": "Only issues opened by this login"
          },
          "query": {
            "type": "string",
            "description": "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "repo",
          "labels"
        ]
      },
      "events": [
        {
          "source": {
            "type": "github-issues",
            "repo": "example-org/example-repo",
            "labels": [
              "agent"
            ]
          },
          "kind": "item.unmatched",
          "id": "item.unmatched:example-org/example-repo#48:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "GitHub issue example-org/example-repo#48 no longer matches label agent",
          "body": "https://github.com/example-org/example-repo/issues/48",
          "actionable": false,
          "subject": {
            "type": "github-issue",
            "key": "example-org/example-repo#48",
            "repo": "example-org/example-repo",
            "number": 48,
            "url": "https://github.com/example-org/example-repo/issues/48"
          }
        },
        {
          "source": {
            "type": "github-issues",
            "repo": "example-org/example-repo",
            "labels": [
              "agent"
            ]
          },
          "kind": "item.matched",
          "id": "item.matched:example-org/example-repo#51:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "GitHub issue example-org/example-repo#51 matches label agent: Issue 51",
          "body": "https://github.com/example-org/example-repo/issues/51",
          "actionable": true,
          "subject": {
            "type": "github-issue",
            "key": "example-org/example-repo#51",
            "repo": "example-org/example-repo",
            "number": 51,
            "url": "https://github.com/example-org/example-repo/issues/51",
            "title": "Issue 51"
          }
        }
      ],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "example-org/example-repo#49",
          "example-org/example-repo#51"
        ],
        "overLimit": false,
        "etag": "W/\"b\""
      },
      "terminal": false
    },
    {
      "name": "search",
      "build": {
        "name": "agent issues",
        "sourceType": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ],
        "query": "milestone:v2",
        "includeExisting": true
      },
      "cursor": null,
      "replies": [
        {
          "body": {
            "total_count": 1,
            "incomplete_results": false,
            "items": [
              {
                "number": 52,
                "title": "Issue 52",
                "html_url": "https://github.com/example-org/example-repo/issues/52",
                "state": "open",
                "labels": [
                  {
                    "name": "agent"
                  }
                ]
              }
            ]
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://api.github.com/search/issues?q=repo%3Aexample-org%2Fexample-repo+is%3Aissue+is%3Aopen+label%3A%22agent%22+milestone%3Av2&per_page=100&sort=created&order=asc",
          "headers": {
            "authorization": "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "accept": "application/vnd.github+json"
          }
        }
      ],
      "source": {
        "type": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ],
        "query": "milestone:v2",
        "includeExisting": true
      },
      "key": "github-issues:example-org/example-repo:agent:::milestone:v2",
      "label": "agent",
      "detail": " example-org/example-repo · label agent, \"milestone:v2\"",
      "describe": "GitHub issues in example-org/example-repo with label agent, \"milestone:v2\"",
      "icon": "󰊤",
      "schema": {
        "description": "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "repo": {
            "type": "string",
            "description": "GitHub owner/name, e.g. owner/repository"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "description": "Labels an issue must all carry"
          },
          "assignee": {
            "type": "string",
            "description": "Only issues assigned to this login"
          },
          "author": {
            "type": "string",
            "description": "Only issues opened by this login"
          },
          "query": {
            "type": "string",
            "description": "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "repo",
          "labels"
        ]
      },
      "events": [
        {
          "source": {
            "type": "github-issues",
            "repo": "example-org/example-repo",
            "labels": [
              "agent"
            ],
            "query": "milestone:v2",
            "includeExisting": true
          },
          "kind": "item.matched",
          "id": "item.matched:example-org/example-repo#52:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "GitHub issue example-org/example-repo#52 matches label agent, \"milestone:v2\": Issue 52",
          "body": "https://github.com/example-org/example-repo/issues/52",
          "actionable": true,
          "subject": {
            "type": "github-issue",
            "key": "example-org/example-repo#52",
            "repo": "example-org/example-repo",
            "number": 52,
            "url": "https://github.com/example-org/example-repo/issues/52",
            "title": "Issue 52"
          }
        }
      ],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "example-org/example-repo#52"
        ],
        "overLimit": false
      },
      "terminal": false
    },
    {
      "name": "rate-limited",
      "build": {
        "name": "agent issues",
        "sourceType": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "cursor": null,
      "replies": [
        {
          "status": 429,
          "headers": {
            "retry-after": "60"
          },
          "body": {
            "message": "API rate limit exceeded"
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://api.github.com/repos/example-org/example-repo/issues?state=open&labels=agent&per_page=100",
          "headers": {
            "authorization": "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "accept": "application/vnd.github+json"
          }
        }
      ],
      "source": {
        "type": "github-issues",
        "repo": "example-org/example-repo",
        "labels": [
          "agent"
        ]
      },
      "key": "github-issues:example-org/example-repo:agent:::",
      "label": "agent",
      "detail": " example-org/example-repo · label agent",
      "describe": "GitHub issues in example-org/example-repo with label agent",
      "icon": "󰊤",
      "schema": {
        "description": "Open GitHub issues in a repository carrying every given label: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "repo": {
            "type": "string",
            "description": "GitHub owner/name, e.g. owner/repository"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "description": "Labels an issue must all carry"
          },
          "assignee": {
            "type": "string",
            "description": "Only issues assigned to this login"
          },
          "author": {
            "type": "string",
            "description": "Only issues opened by this login"
          },
          "query": {
            "type": "string",
            "description": "Extra GitHub search terms, e.g. 'milestone:v2'; uses the search API"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "repo",
          "labels"
        ]
      },
      "deferred": true
    }
  ]
}
