import type { GoldenFixture } from "@sourcefed/sdk"

/** What the pre-SDK jira-query provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const JIRA_QUERY_GOLDEN: GoldenFixture = {
  "provider": "jira-query",
  "recordedFrom": "0a1a5e7",
  "base": "https://jira.example",
  "now": "2026-11-18T12:00:00.000Z",
  "cases": [
    {
      "name": "priming",
      "build": {
        "name": "agent work",
        "sourceType": "jira-query",
        "jql": "project = PROJ AND labels = agent"
      },
      "cursor": null,
      "replies": [
        {
          "body": {
            "issues": [
              {
                "key": "PROJ-1",
                "fields": {
                  "summary": "Issue 1"
                }
              },
              {
                "key": "PROJ-2",
                "fields": {
                  "summary": "Issue 2"
                }
              }
            ],
            "isLast": true
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://jira.example/rest/api/3/search/jql?jql=project+%3D+PROJ+AND+labels+%3D+agent+ORDER+BY+key+ASC&fields=summary&maxResults=100",
          "headers": {
            "authorization": "«redacted»",
            "accept": "application/json"
          }
        }
      ],
      "source": {
        "type": "jira-query",
        "jql": "project = PROJ AND labels = agent"
      },
      "key": "jira-query:project = PROJ AND labels = agent",
      "label": "JQL",
      "detail": " project = PROJ AND labels = agent",
      "describe": "Jira issues matching \"project = PROJ AND labels = agent\"",
      "icon": "󰌃",
      "schema": {
        "description": "Jira issues matching a JQL query: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "jql": {
            "type": "string",
            "minLength": 1,
            "description": "A bounded JQL query, e.g. 'project = PROJ AND labels = agent'"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "jql"
        ]
      },
      "events": [],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "PROJ-1",
          "PROJ-2"
        ],
        "overLimit": false
      },
      "terminal": false
    },
    {
      "name": "change",
      "build": {
        "name": "agent work",
        "sourceType": "jira-query",
        "jql": "project = PROJ AND labels = agent"
      },
      "cursor": {
        "primed": true,
        "keys": [
          "PROJ-1",
          "PROJ-2"
        ],
        "overLimit": false
      },
      "replies": [
        {
          "body": {
            "issues": [
              {
                "key": "PROJ-2",
                "fields": {
                  "summary": "Issue 2"
                }
              },
              {
                "key": "PROJ-3",
                "fields": {
                  "summary": "Issue 3"
                }
              }
            ],
            "isLast": true
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://jira.example/rest/api/3/search/jql?jql=project+%3D+PROJ+AND+labels+%3D+agent+ORDER+BY+key+ASC&fields=summary&maxResults=100",
          "headers": {
            "authorization": "«redacted»",
            "accept": "application/json"
          }
        }
      ],
      "source": {
        "type": "jira-query",
        "jql": "project = PROJ AND labels = agent"
      },
      "key": "jira-query:project = PROJ AND labels = agent",
      "label": "JQL",
      "detail": " project = PROJ AND labels = agent",
      "describe": "Jira issues matching \"project = PROJ AND labels = agent\"",
      "icon": "󰌃",
      "schema": {
        "description": "Jira issues matching a JQL query: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "jql": {
            "type": "string",
            "minLength": 1,
            "description": "A bounded JQL query, e.g. 'project = PROJ AND labels = agent'"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "jql"
        ]
      },
      "events": [
        {
          "source": {
            "type": "jira-query",
            "jql": "project = PROJ AND labels = agent"
          },
          "kind": "item.unmatched",
          "id": "item.unmatched:PROJ-1:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "Jira PROJ-1 no longer matches \"project = PROJ AND labels = agent\"",
          "body": "https://jira.example/browse/PROJ-1",
          "actionable": false,
          "subject": {
            "type": "jira-issue",
            "key": "PROJ-1",
            "url": "https://jira.example/browse/PROJ-1"
          }
        },
        {
          "source": {
            "type": "jira-query",
            "jql": "project = PROJ AND labels = agent"
          },
          "kind": "item.matched",
          "id": "item.matched:PROJ-3:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "Jira PROJ-3 matches \"project = PROJ AND labels = agent\": Issue 3",
          "body": "https://jira.example/browse/PROJ-3",
          "actionable": true,
          "subject": {
            "type": "jira-issue",
            "key": "PROJ-3",
            "url": "https://jira.example/browse/PROJ-3",
            "title": "Issue 3"
          }
        }
      ],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "PROJ-2",
          "PROJ-3"
        ],
        "overLimit": false
      },
      "terminal": false
    },
    {
      "name": "paged-existing",
      "build": {
        "name": "agent work",
        "sourceType": "jira-query",
        "jql": "project = PROJ AND labels = agent",
        "includeExisting": true
      },
      "cursor": null,
      "replies": [
        {
          "body": {
            "issues": [
              {
                "key": "PROJ-4",
                "fields": {
                  "summary": "Issue 4"
                }
              }
            ],
            "nextPageToken": "t2",
            "isLast": false
          }
        },
        {
          "body": {
            "issues": [
              {
                "key": "PROJ-5",
                "fields": {
                  "summary": "Issue 5"
                }
              }
            ],
            "isLast": true
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://jira.example/rest/api/3/search/jql?jql=project+%3D+PROJ+AND+labels+%3D+agent+ORDER+BY+key+ASC&fields=summary&maxResults=100",
          "headers": {
            "authorization": "«redacted»",
            "accept": "application/json"
          }
        },
        {
          "method": "GET",
          "url": "https://jira.example/rest/api/3/search/jql?jql=project+%3D+PROJ+AND+labels+%3D+agent+ORDER+BY+key+ASC&fields=summary&maxResults=100&nextPageToken=t2",
          "headers": {
            "authorization": "«redacted»",
            "accept": "application/json"
          }
        }
      ],
      "source": {
        "type": "jira-query",
        "jql": "project = PROJ AND labels = agent",
        "includeExisting": true
      },
      "key": "jira-query:project = PROJ AND labels = agent",
      "label": "JQL",
      "detail": " project = PROJ AND labels = agent",
      "describe": "Jira issues matching \"project = PROJ AND labels = agent\"",
      "icon": "󰌃",
      "schema": {
        "description": "Jira issues matching a JQL query: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "jql": {
            "type": "string",
            "minLength": 1,
            "description": "A bounded JQL query, e.g. 'project = PROJ AND labels = agent'"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "jql"
        ]
      },
      "events": [
        {
          "source": {
            "type": "jira-query",
            "jql": "project = PROJ AND labels = agent",
            "includeExisting": true
          },
          "kind": "item.matched",
          "id": "item.matched:PROJ-4:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "Jira PROJ-4 matches \"project = PROJ AND labels = agent\": Issue 4",
          "body": "https://jira.example/browse/PROJ-4",
          "actionable": true,
          "subject": {
            "type": "jira-issue",
            "key": "PROJ-4",
            "url": "https://jira.example/browse/PROJ-4",
            "title": "Issue 4"
          }
        },
        {
          "source": {
            "type": "jira-query",
            "jql": "project = PROJ AND labels = agent",
            "includeExisting": true
          },
          "kind": "item.matched",
          "id": "item.matched:PROJ-5:2026-11-18T12:00:00.000Z",
          "at": "2026-11-18T12:00:00.000Z",
          "summary": "Jira PROJ-5 matches \"project = PROJ AND labels = agent\": Issue 5",
          "body": "https://jira.example/browse/PROJ-5",
          "actionable": true,
          "subject": {
            "type": "jira-issue",
            "key": "PROJ-5",
            "url": "https://jira.example/browse/PROJ-5",
            "title": "Issue 5"
          }
        }
      ],
      "cursorAfter": {
        "primed": true,
        "keys": [
          "PROJ-4",
          "PROJ-5"
        ],
        "overLimit": false
      },
      "terminal": false
    },
    {
      "name": "unbounded",
      "build": {
        "name": "agent work",
        "sourceType": "jira-query",
        "jql": "labels = agent"
      },
      "cursor": null,
      "replies": [
        {
          "status": 400,
          "body": {
            "errorMessages": [
              "Unbounded JQL queries are not allowed here. Please add a search restriction to your query."
            ],
            "errors": {}
          }
        }
      ],
      "requests": [
        {
          "method": "GET",
          "url": "https://jira.example/rest/api/3/search/jql?jql=labels+%3D+agent+ORDER+BY+key+ASC&fields=summary&maxResults=100",
          "headers": {
            "authorization": "«redacted»",
            "accept": "application/json"
          }
        }
      ],
      "source": {
        "type": "jira-query",
        "jql": "labels = agent"
      },
      "key": "jira-query:labels = agent",
      "label": "JQL",
      "detail": " labels = agent",
      "describe": "Jira issues matching \"labels = agent\"",
      "icon": "󰌃",
      "schema": {
        "description": "Jira issues matching a JQL query: item.matched when an issue starts matching, item.unmatched when it stops",
        "properties": {
          "jql": {
            "type": "string",
            "minLength": 1,
            "description": "A bounded JQL query, e.g. 'project = PROJ AND labels = agent'"
          },
          "includeExisting": {
            "type": "boolean",
            "description": "Send item.matched for every issue already matching on the first poll"
          }
        },
        "required": [
          "jql"
        ]
      },
      "error": "Jira search answered 400: Unbounded JQL queries are not allowed here. Please add a search restriction to your query."
    }
  ]
}
