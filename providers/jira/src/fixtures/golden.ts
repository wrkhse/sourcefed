import type { GoldenFixture } from "@sourcefed/sdk";

/** What the pre-SDK jira provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const JIRA_GOLDEN: GoldenFixture = {
  provider: "jira",
  recordedFrom: "0a1a5e7",
  base: "https://jira.example",
  cases: [
    {
      name: "priming",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: null,
      replies: [
        {
          body: {
            comments: [],
          },
        },
        {
          body: {
            fields: {
              status: {
                name: "In Progress",
              },
              description: {
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "first",
                      },
                    ],
                  },
                ],
              },
              summary: "Add schedules",
            },
            changelog: {
              histories: [],
            },
          },
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9?expand=changelog&fields=status,description,summary",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      events: [],
      cursorAfter: {
        commentIds: [],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      terminal: false,
    },
    {
      name: "comment-prime",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: {
        commentIds: [],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      replies: [
        {
          body: {
            comments: [
              {
                id: "100",
                author: {
                  displayName: "Alice",
                },
                created: "2026-11-18T10:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "first comment",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          body: {
            fields: {
              status: {
                name: "In Progress",
              },
              description: {
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "first",
                      },
                    ],
                  },
                ],
              },
              summary: "Add schedules",
            },
            changelog: {
              histories: [],
            },
          },
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9?expand=changelog&fields=status,description,summary",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      events: [],
      cursorAfter: {
        commentIds: [100],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      terminal: false,
    },
    {
      name: "comment",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: {
        commentIds: [100],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      replies: [
        {
          body: {
            comments: [
              {
                id: "101",
                author: {
                  displayName: "Bob",
                },
                created: "2026-11-18T12:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "new comment after priming",
                        },
                      ],
                    },
                  ],
                },
              },
              {
                id: "100",
                author: {
                  displayName: "Alice",
                },
                created: "2026-11-18T10:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "first comment",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          body: {
            fields: {
              status: {
                name: "In Progress",
              },
              description: {
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "first",
                      },
                    ],
                  },
                ],
              },
              summary: "Add schedules",
            },
            changelog: {
              histories: [],
            },
          },
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9?expand=changelog&fields=status,description,summary",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      events: [
        {
          source: {
            type: "jira",
            issueKey: "PROJ-9",
          },
          kind: "comment",
          id: "comment:101",
          at: "2026-11-18T12:00:00.000Z",
          summary: "Jira PROJ-9 comment by Bob",
          body: "new comment after priming",
          actionable: true,
          subject: {
            type: "jira-issue",
            key: "PROJ-9",
            url: "https://jira.example/browse/PROJ-9",
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        commentIds: [100, 101],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      terminal: false,
    },
    {
      name: "changelog-prime",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: {
        commentIds: [100, 101],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: [],
      },
      replies: [
        {
          body: {
            comments: [
              {
                id: "101",
                author: {
                  displayName: "Bob",
                },
                created: "2026-11-18T12:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "new comment after priming",
                        },
                      ],
                    },
                  ],
                },
              },
              {
                id: "100",
                author: {
                  displayName: "Alice",
                },
                created: "2026-11-18T10:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "first comment",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          body: {
            fields: {
              status: {
                name: "In Progress",
              },
              description: {
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "first",
                      },
                    ],
                  },
                ],
              },
              summary: "Add schedules",
            },
            changelog: {
              histories: [
                {
                  id: "h0",
                  created: "2026-11-18T09:00:00.000Z",
                  author: {
                    displayName: "Alice",
                  },
                  items: [
                    {
                      field: "status",
                      fromString: "To Do",
                      toString: "In Progress",
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9?expand=changelog&fields=status,description,summary",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      events: [],
      cursorAfter: {
        commentIds: [100, 101],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: ["h0"],
      },
      terminal: false,
    },
    {
      name: "status-change",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: {
        commentIds: [100, 101],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: ["h0"],
      },
      replies: [
        {
          body: {
            comments: [
              {
                id: "101",
                author: {
                  displayName: "Bob",
                },
                created: "2026-11-18T12:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "new comment after priming",
                        },
                      ],
                    },
                  ],
                },
              },
              {
                id: "100",
                author: {
                  displayName: "Alice",
                },
                created: "2026-11-18T10:00:00.000Z",
                body: {
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "first comment",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          body: {
            fields: {
              status: {
                name: "In Progress",
              },
              description: {
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "first",
                      },
                    ],
                  },
                ],
              },
              summary: "Add schedules",
            },
            changelog: {
              histories: [
                {
                  id: "h1",
                  created: "2026-11-18T11:00:00.000Z",
                  author: {
                    displayName: "Bob",
                  },
                  items: [
                    {
                      field: "status",
                      fromString: "In Progress",
                      toString: "Done",
                    },
                  ],
                },
                {
                  id: "h0",
                  created: "2026-11-18T09:00:00.000Z",
                  author: {
                    displayName: "Alice",
                  },
                  items: [
                    {
                      field: "status",
                      fromString: "To Do",
                      toString: "In Progress",
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9?expand=changelog&fields=status,description,summary",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      events: [
        {
          source: {
            type: "jira",
            issueKey: "PROJ-9",
          },
          kind: "changelog",
          id: "history:h1",
          at: "2026-11-18T11:00:00.000Z",
          summary: "Jira PROJ-9 status: In Progress → Done",
          body: "status: In Progress → Done",
          actionable: true,
          terminal: false,
          subject: {
            type: "jira-issue",
            key: "PROJ-9",
            url: "https://jira.example/browse/PROJ-9",
            title: "Add schedules",
          },
        },
      ],
      cursorAfter: {
        commentIds: [100, 101],
        descriptionVersion: '{"content":[{"type":"paragraph","content',
        changelogIds: ["h0", "h1"],
      },
      terminal: false,
    },
    {
      name: "rate-limited",
      build: {
        name: "PROJ-9",
        sourceType: "jira",
        issueKey: "PROJ-9",
      },
      cursor: null,
      replies: [
        {
          status: 429,
          body: {},
        },
      ],
      requests: [
        {
          method: "GET",
          url: "https://jira.example/rest/api/3/issue/PROJ-9/comment?maxResults=50&orderBy=-created",
          headers: {
            authorization: "«redacted»",
            accept: "application/json",
          },
        },
      ],
      source: {
        type: "jira",
        issueKey: "PROJ-9",
      },
      key: "jira:PROJ-9",
      label: "PROJ-9",
      detail: " PROJ-9",
      describe: "Jira PROJ-9",
      icon: "󰌃",
      schema: {
        description:
          "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
        properties: {
          issueKey: {
            type: "string",
            description: "Jira issue key, e.g. PROJ-12345",
          },
        },
        required: ["issueKey"],
      },
      error:
        "Jira 429 for /issue/PROJ-9/comment?maxResults=50&orderBy=-created",
    },
  ],
};
