import { toMonitorEvent } from "@sourcefed/core"
import type { MonitorCreateInput, SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import type { SlackSourceRecord } from "./types"
import { SlackSourceSchema } from "./schema.ts"
import { pollSlack } from "./poll"
import { parseSlackWebhook, validSlackSignature } from "./webhook"
import { updateSlackCursor } from "./webhook/utils/update-slack-cursor.ts"

/** A Slack thread or DM as data, plus the poll and webhook the host drives with its own http and clock. */
export const slackSource: SourceDefinition<SlackSourceRecord> = {
  type: "slack",
  schema: SlackSourceSchema,
  input: {
    description: "A Slack thread's new replies, or a whole DM's new messages; read-only, never replies. Give threadUrl, or channelId with threadTs, or a D… DM channelId alone",
    properties: {
      threadUrl: { type: "string", description: "Slack thread URL" },
      channelId: { type: "string", description: "Slack channel or DM ID; a DM ID without threadTs watches the whole DM" },
      threadTs: { type: "string", description: "Slack parent message timestamp" },
    },
    required: [],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (input.channelId && input.threadTs) return { type: "slack", channelId: input.channelId, threadTs: input.threadTs }
    if (input.channelId?.startsWith("D")) return { type: "slack", channelId: input.channelId }
    if (input.channelId) return { error: "threadTs is required unless channelId is a Slack DM ID" }
    if (!input.threadUrl) return { error: "channelId or threadUrl is required for a slack monitor" }

    let url: URL
    try {
      url = new URL(input.threadUrl)
    } catch {
      return { error: "threadUrl must be a valid Slack URL" }
    }
    const channelId = url.pathname.match(/\/archives\/([^/]+)/)?.[1]
    const pathTimestamp = url.pathname.match(/\/p(\d{10,})/)?.[1]
    let threadTs = url.searchParams.get("thread_ts") ?? undefined
    if (!threadTs && pathTimestamp) threadTs = `${pathTimestamp.slice(0, -6)}.${pathTimestamp.slice(-6)}`
    if (channelId && threadTs) return { type: "slack", channelId, threadTs }
    return { error: "threadUrl does not contain a Slack channel and thread timestamp" }
  },
  key: (source) => source.threadTs
    ? `slack:${source.channelId}#${source.threadTs}`
    : `slack:${source.channelId}`,
  label: (source) => source.threadTs ? "thread" : "DM",
  detail: (source) => ` ${source.channelId}`,
  describe: (source) => source.threadTs
    ? `Slack ${source.channelId} thread ${source.threadTs}`
    : `Slack DM ${source.channelId}`,
  icon: "󰒱",
  poll: async ({ source, cursor, monitorId, http, now }) => {
    const result = await pollSlack(http, now, source, cursor, monitorId)
    if ("deferred" in result) return result

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: result.terminal,
    }
  },
  webhook: {
    path: "/webhooks/slack",
    preferred: true,
    configured: () => Boolean(process.env.SOURCEFED_SLACK_SIGNING_SECRET),
    verify: (body, request, now) => validSlackSignature(body, request, now),
    acknowledgeBeforeDelivery: true,
    challenge: (payload: any) => {
      if (payload.type === "url_verification" && payload.challenge) return { challenge: payload.challenge }
      return undefined
    },
    deliveryId: (_request: Request, payload: any) => payload.event_id,
    eventName: () => "slack",
    parse: parseSlackWebhook,
    updateCursor: updateSlackCursor,
  },
}

/** The monitor the daemon registers. */
export const SlackMonitor = defineSource(slackSource)
