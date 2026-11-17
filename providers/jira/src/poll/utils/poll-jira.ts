import * as v from "valibot"
import { subjectTitle, type EventSubject } from "@sourcefed/core"
import { appendJiraChangelog } from "./append-jira-changelog.ts"
import { appendJiraComments } from "./append-jira-comments.ts"
import { appendJiraDescription } from "./append-jira-description.ts"
import { emptyJiraCursor } from "./empty-cursor.ts"
import { isTerminalStatus } from "./is-terminal-status.ts"
import { jiraFetch } from "./jira-fetch.ts"
import { issueUrl } from "../../query/api.ts"
import { JiraCursorSchema } from "../../schema.ts"
import type { JiraCursor, JiraEvent } from "../../types"

export async function pollJira(issueKey: string, cursorRaw: unknown): Promise<{ events: JiraEvent[]; cursor: JiraCursor; terminal: boolean }> {
  const parsedCursor = v.safeParse(JiraCursorSchema, cursorRaw)
  let cursor = emptyJiraCursor()
  if (parsedCursor.success) cursor = parsedCursor.output
  const events: JiraEvent[] = []

  const comments = await jiraFetch(`/issue/${issueKey}/comment?maxResults=50&orderBy=-created`)
  appendJiraComments(issueKey, cursor, events, comments.comments ?? [])

  const issue = await jiraFetch(`/issue/${issueKey}?expand=changelog&fields=status,description,summary`)
  const statusName = issue.fields?.status?.name
  appendJiraDescription(issueKey, cursor, events, issue.fields?.description)

  const changelog = issue.changelog?.histories ?? []
  appendJiraChangelog(issueKey, cursor, events, changelog)

  const subject = issueSubject(issueKey, issue.fields?.summary)
  for (const event of events) {
    if (!event.subject) event.subject = { ...subject }
  }

  return { events, cursor, terminal: isTerminalStatus(statusName) }
}

function issueSubject(issueKey: string, summary: unknown): EventSubject {
  const subject: EventSubject = { type: "jira-issue", key: issueKey, url: issueUrl(issueKey) }
  const title = subjectTitle(summary)
  // An issue with no summary still has a subject; only the title is left out.
  if (title !== undefined) subject.title = title
  return subject
}
