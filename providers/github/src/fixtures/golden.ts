import type { GoldenFixture } from "@sourcefed/sdk";

/** What the pre-SDK github provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const GITHUB_GOLDEN: GoldenFixture = {
  provider: "github",
  recordedFrom: "0a1a5e7",
  base: "https://api.github.com",
  cases: [
    {
      name: "priming",
      now: "2026-11-18T12:00:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: null,
      replies: [
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "SUCCESS",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/41",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          body: [],
        },
        {
          body: [],
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/issues/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      events: [],
      cursorAfter: {
        reviewIds: [],
        commentIds: [],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "SUCCESS",
        ciFailureState: "",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      terminal: false,
    },
    {
      name: "review-and-comments",
      now: "2026-11-18T12:01:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: {
        reviewIds: [],
        commentIds: [],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "SUCCESS",
        ciFailureState: "",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      replies: [
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [
                      {
                        databaseId: 501,
                        author: {
                          login: "alice",
                        },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-11-18T12:00:30Z",
                        body: "Please add a test.",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "SUCCESS",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/41",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          body: [
            {
              id: 601,
              user: {
                login: "bob",
              },
              path: "src/a.ts",
              line: 3,
              body: "Typo here.",
              created_at: "2026-11-18T12:00:40Z",
            },
          ],
        },
        {
          body: [
            {
              id: 701,
              user: {
                login: "carol",
              },
              body: "Looks close.",
              created_at: "2026-11-18T12:00:50Z",
            },
          ],
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/issues/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      events: [
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "review",
          id: "rev:501",
          at: "2026-11-18T12:00:30Z",
          summary: "Review by alice [CHANGES_REQUESTED] on #7",
          body: "Please add a test.",
          actionable: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "comment",
          id: "c:601",
          at: "2026-11-18T12:00:40Z",
          summary: "Comment by bob on src/a.ts",
          body: "src/a.ts:3 — Typo here.",
          actionable: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "comment",
          id: "issue:701",
          at: "2026-11-18T12:00:50Z",
          summary: "Comment by carol on #7",
          body: "Looks close.",
          actionable: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "SUCCESS",
        ciFailureState: "",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      terminal: false,
    },
    {
      name: "ci-failure",
      now: "2026-11-18T12:02:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "SUCCESS",
        ciFailureState: "",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      replies: [
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [
                      {
                        databaseId: 501,
                        author: {
                          login: "alice",
                        },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-11-18T12:00:30Z",
                        body: "Please add a test.",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "FAILURE",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/42",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          body: [
            {
              id: 601,
              user: {
                login: "bob",
              },
              path: "src/a.ts",
              line: 3,
              body: "Typo here.",
              created_at: "2026-11-18T12:00:40Z",
            },
          ],
        },
        {
          body: [
            {
              id: 701,
              user: {
                login: "carol",
              },
              body: "Looks close.",
              created_at: "2026-11-18T12:00:50Z",
            },
          ],
        },
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [
                      {
                        databaseId: 501,
                        author: {
                          login: "alice",
                        },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-11-18T12:00:30Z",
                        body: "Please add a test.",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "FAILURE",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/42",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          text: "##[group]Run npm test\nnot ok 1 - adds a schedule\n##[error]Process completed with exit code 1.",
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/issues/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/actions/jobs/42/logs",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      events: [
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "ci",
          id: "ci:build:FAILURE",
          at: "2026-11-18T12:02:00.000Z",
          summary: "CI failed on #7: build",
          body: "- build: FAILURE\n\n### Failing log: build\n```\n##[group]Run npm test\nnot ok 1 - adds a schedule\n##[error]Process completed with exit code 1.\n```",
          actionable: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "FAILURE",
        ciFailureState: "build:FAILURE",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      terminal: false,
    },
    {
      name: "conflict",
      now: "2026-11-18T12:03:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "FAILURE",
        ciFailureState: "build:FAILURE",
        mergeable: "MERGEABLE",
        prState: "OPEN",
      },
      replies: [
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "OPEN",
                  mergeable: "CONFLICTING",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [
                      {
                        databaseId: 501,
                        author: {
                          login: "alice",
                        },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-11-18T12:00:30Z",
                        body: "Please add a test.",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "FAILURE",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/42",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          body: [
            {
              id: 601,
              user: {
                login: "bob",
              },
              path: "src/a.ts",
              line: 3,
              body: "Typo here.",
              created_at: "2026-11-18T12:00:40Z",
            },
          ],
        },
        {
          body: [
            {
              id: 701,
              user: {
                login: "carol",
              },
              body: "Looks close.",
              created_at: "2026-11-18T12:00:50Z",
            },
          ],
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/issues/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      events: [
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "conflict",
          id: "conflict:CONFLICTING",
          at: "2026-11-18T12:03:00.000Z",
          summary: "PR #7 now has merge conflicts with its base (CONFLICTING)",
          actionable: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "FAILURE",
        ciFailureState: "build:FAILURE",
        mergeable: "CONFLICTING",
        prState: "OPEN",
      },
      terminal: false,
    },
    {
      name: "merged",
      now: "2026-11-18T12:04:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "FAILURE",
        ciFailureState: "build:FAILURE",
        mergeable: "CONFLICTING",
        prState: "OPEN",
      },
      replies: [
        {
          body: {
            data: {
              repository: {
                pullRequest: {
                  title: "Add schedules",
                  state: "MERGED",
                  mergeable: "CONFLICTING",
                  mergeStateStatus: "CLEAN",
                  reviews: {
                    nodes: [
                      {
                        databaseId: 501,
                        author: {
                          login: "alice",
                        },
                        state: "CHANGES_REQUESTED",
                        submittedAt: "2026-11-18T12:00:30Z",
                        body: "Please add a test.",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "build",
                          conclusion: "FAILURE",
                          detailsUrl:
                            "https://github.com/example-org/example-repo/actions/runs/9/job/42",
                        },
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          body: [
            {
              id: 601,
              user: {
                login: "bob",
              },
              path: "src/a.ts",
              line: 3,
              body: "Typo here.",
              created_at: "2026-11-18T12:00:40Z",
            },
          ],
        },
        {
          body: [
            {
              id: 701,
              user: {
                login: "carol",
              },
              body: "Looks close.",
              created_at: "2026-11-18T12:00:50Z",
            },
          ],
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
        {
          method: "GET",
          url: "https://api.github.com/repos/example-org/example-repo/issues/7/comments?per_page=100&page=1",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            accept: "application/vnd.github+json",
          },
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      events: [
        {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "merged",
          id: "state:MERGED",
          at: "2026-11-18T12:04:00.000Z",
          summary: "PR #7 was MERGED",
          actionable: true,
          terminal: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        reviewIds: ["rev:501"],
        commentIds: ["c:601", "issue:701"],
        historyPrimed: true,
        lineCommentsPrimed: true,
        conversationCommentsPrimed: true,
        ciState: "FAILURE",
        ciFailureState: "build:FAILURE",
        mergeable: "CONFLICTING",
        prState: "MERGED",
      },
      terminal: true,
    },
    {
      name: "rate-limited",
      now: "2026-11-18T12:05:00.000Z",
      build: {
        name: "PR 7",
        sourceType: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      cursor: null,
      replies: [
        {
          headers: {
            "retry-after": "60",
          },
          body: {
            errors: [
              {
                type: "RATE_LIMITED",
                message: "API rate limit exceeded",
              },
            ],
          },
        },
      ],
      requests: [
        {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {
            authorization: "«redacted»",
            "user-agent": "sourcefed",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
          },
          body: '{"query":"\\nquery PullRequestData($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $contextsAfter: String) {\\n  repository(owner: $owner, name: $name) {\\n    pullRequest(number: $number) {\\n      title\\n      state\\n      mergeable\\n      mergeStateStatus\\n      reviews(first: 100, after: $reviewsAfter) {\\n        nodes {\\n          databaseId\\n          author { login }\\n          state\\n          submittedAt\\n          body\\n        }\\n        pageInfo {\\n          hasNextPage\\n          endCursor\\n        }\\n      }\\n      statusCheckRollup {\\n        contexts(first: 100, after: $contextsAfter) {\\n          nodes {\\n            ... on StatusContext {\\n              context\\n              state\\n              targetUrl\\n            }\\n            ... on CheckRun {\\n              name\\n              conclusion\\n              detailsUrl\\n            }\\n          }\\n          pageInfo {\\n            hasNextPage\\n            endCursor\\n          }\\n        }\\n      }\\n    }\\n  }\\n}","variables":{"owner":"example-org","name":"example-repo","number":7}}',
        },
      ],
      source: {
        type: "github",
        repo: "example-org/example-repo",
        prNumber: 7,
      },
      key: "github:example-org/example-repo#7",
      label: "#7",
      detail: " example-org/example-repo#7",
      describe: "GitHub example-org/example-repo#7",
      icon: "󰊤",
      schema: {
        description:
          "A GitHub pull request: reviews, comments, CI failures, conflicts, merge or close",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/name, e.g. owner/repository",
          },
          prNumber: {
            type: "integer",
            minimum: 1,
            description: "Pull request number",
          },
        },
        required: ["repo", "prNumber"],
      },
      deferred: true,
    },
  ],
  webhook: {
    path: "/webhooks/github",
    preferred: true,
    acknowledgeBeforeDelivery: false,
    configured: true,
    cases: [
      {
        name: "bad-signature",
        now: "2026-11-18T12:06:00.000Z",
        headers: {
          "x-github-event": "pull_request_review",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256":
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: '{"action":"submitted","review":{"id":503,"state":"commented","body":"Unsigned.","user":{"login":"mallory"}},"pull_request":{"number":7,"title":"Add schedules"},"repository":{"full_name":"example-org/example-repo"},"sender":{"login":"mallory"}}',
        cursor: null,
        verified: false,
      },
      {
        name: "review",
        now: "2026-11-18T12:07:00.000Z",
        headers: {
          "x-github-event": "pull_request_review",
          "x-github-delivery": "delivery-2",
          "x-hub-signature-256":
            "sha256=92ea9ea5659d7d59058324959009cfbc07d17b934213969ec32c98d6ba58b7bc",
        },
        body: '{"action":"submitted","review":{"id":502,"state":"commented","body":"One more nit.","user":{"login":"alice"}},"pull_request":{"number":7,"title":"Add schedules"},"repository":{"full_name":"example-org/example-repo","updated_at":"2026-11-18T12:07:00Z"},"sender":{"login":"alice"}}',
        cursor: {
          reviewIds: ["rev:501"],
          commentIds: ["c:601", "issue:701"],
          historyPrimed: true,
          lineCommentsPrimed: true,
          conversationCommentsPrimed: true,
          ciState: "SUCCESS",
          ciFailureState: "",
          mergeable: "MERGEABLE",
          prState: "OPEN",
        },
        verified: true,
        challenge: null,
        deliveryId: "delivery-2",
        eventName: "pull_request_review",
        event: {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "review",
          id: "review:502",
          at: "2026-11-18T12:07:00Z",
          summary:
            "GitHub review submitted by alice on example-org/example-repo#7",
          body: "One more nit.",
          actionable: true,
          terminal: false,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
        cursorAfter: {
          reviewIds: ["rev:501", "rev:502"],
          commentIds: ["c:601", "issue:701"],
          historyPrimed: true,
          lineCommentsPrimed: true,
          conversationCommentsPrimed: true,
          ciState: "SUCCESS",
          ciFailureState: "",
          mergeable: "MERGEABLE",
          prState: "OPEN",
        },
      },
      {
        name: "ping",
        now: "2026-11-18T12:08:00.000Z",
        headers: {
          "x-github-event": "ping",
          "x-github-delivery": "delivery-3",
          "x-hub-signature-256":
            "sha256=e9f46345f1b3b0fcaa3f17c1f5673a041f084ffb28d51406bfe6f464a52083a5",
        },
        body: '{"zen":"Design for failure.","hook_id":1}',
        cursor: null,
        verified: true,
        challenge: null,
        deliveryId: "delivery-3",
        eventName: "ping",
        event: null,
        cursorAfter: null,
      },
      {
        name: "merged",
        now: "2026-11-18T12:09:00.000Z",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-4",
          "x-hub-signature-256":
            "sha256=92f1a692cc922c648ebfd42771a14b38a342ebf9d5ff105ac897e6d857313b08",
        },
        body: '{"action":"closed","pull_request":{"number":7,"merged":true,"title":"Add schedules"},"repository":{"full_name":"example-org/example-repo"}}',
        cursor: null,
        verified: true,
        challenge: null,
        deliveryId: "delivery-4",
        eventName: "pull_request",
        event: {
          source: {
            type: "github",
            repo: "example-org/example-repo",
            prNumber: 7,
          },
          kind: "merged",
          id: "pr:MERGED",
          at: "2026-11-18T12:09:00.000Z",
          summary: "GitHub PR closed and merged on example-org/example-repo#7",
          actionable: true,
          terminal: true,
          subject: {
            type: "github-pull-request",
            key: "example-org/example-repo#7",
            repo: "example-org/example-repo",
            number: 7,
            title: "Add schedules",
          },
        },
        cursorAfter: {
          reviewIds: [],
          commentIds: [],
          historyPrimed: false,
          lineCommentsPrimed: false,
          conversationCommentsPrimed: false,
          ciState: "",
          ciFailureState: "",
          mergeable: "",
          prState: "MERGED",
        },
      },
    ],
  },
};
