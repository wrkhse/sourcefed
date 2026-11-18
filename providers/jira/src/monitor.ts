import { toMonitorEvent } from "@sourcefed/core"
import type { MonitorCreateInput, SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { JiraSourceSchema } from "./schema.ts"
import { pollJira } from "./poll/utils"
import type { JiraSourceRecord } from "./types"

/** Jira as data: what the subclass declared, plus the poll the host drives. */
export const jiraSource: SourceDefinition<JiraSourceRecord> = {
  type: "jira",
  schema: JiraSourceSchema,
  input: {
    description: "A Jira issue: new comments, description edits, and status, assignee, priority or label changes",
    properties: { issueKey: { type: "string", description: "Jira issue key, e.g. PROJ-12345" } },
    required: ["issueKey"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (input.issueKey) return { type: "jira", issueKey: input.issueKey }
    return { error: "issueKey is required for a jira monitor" }
  },
  key: (source) => `jira:${source.issueKey}`,
  label: (source) => source.issueKey,
  detail: (source) => ` ${source.issueKey}`,
  describe: (source) => `Jira ${source.issueKey}`,
  icon: "󰌃",
  poll: async ({ source, cursor, http }) => {
    const result = await pollJira(http, source.issueKey, cursor)

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: result.terminal,
    }
  },
}

/** The monitor the daemon registers. */
export const JiraMonitor = defineSource(jiraSource)
