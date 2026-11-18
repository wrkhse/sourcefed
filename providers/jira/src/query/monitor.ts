import { toMonitorEvent, type MonitorCreateInput, type SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { jiraSearchFetch } from "./api.ts"
import { pollJiraQuery } from "./poll.ts"
import { JiraQuerySourceSchema, type JiraQuerySource } from "./schema.ts"

/** A JQL collection as data, plus the poll the host drives with its own http and clock. */
export const jiraQuerySource: SourceDefinition<JiraQuerySource> = {
  type: "jira-query",
  schema: JiraQuerySourceSchema,
  input: {
    description: "Jira issues matching a JQL query: item.matched when an issue starts matching, item.unmatched when it stops",
    properties: {
      jql: { type: "string", minLength: 1, description: "A bounded JQL query, e.g. 'project = PROJ AND labels = agent'" },
      includeExisting: { type: "boolean", description: "Send item.matched for every issue already matching on the first poll" },
    },
    required: ["jql"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    const jql = input.jql?.trim()
    if (!jql) return { error: "jql is required for a jira-query monitor" }

    const source: JiraQuerySource = { type: "jira-query", jql }
    if (input.includeExisting) source.includeExisting = true
    return source
  },
  key: (source) => `jira-query:${source.jql}`,
  label: () => "JQL",
  detail: (source) => ` ${source.jql}`,
  describe: (source) => `Jira issues matching "${source.jql}"`,
  icon: "󰌃",
  poll: async ({ source, cursor, http, now }) => {
    const result = await pollJiraQuery(source, cursor, jiraSearchFetch(http), now)

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: false,
    }
  },
}

/** The monitor the daemon registers. */
export const JiraQueryMonitor = defineSource(jiraQuerySource)
