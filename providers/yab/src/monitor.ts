import { toMonitorEvent } from "@sourcefed/core"
import type { MonitorCreateInput, SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import type { YabSourceRecord } from "./types"
import { YabSourceSchema } from "./schema.ts"
import { fetchThroughYab, pollYab } from "./poll"

/** A feed read through Yab as data, plus the poll the host drives with its own MCP servers and clock. */
export const yabSource: SourceDefinition<YabSourceRecord> = {
  type: "yab",
  schema: YabSourceSchema,
  input: {
    description: "New entries of an Atom, RSS or JSON feed read through the user's Yab browser with their sign-ins; Yab must be running",
    properties: {
      url: { type: "string", description: "Feed URL, e.g. https://mail.google.com/mail/u/0/feed/atom" },
      space: { type: "string", description: "Yab space whose sign-ins to use; omit to use wherever the site is signed in" },
      match: { type: "string", description: "Case-insensitive regex; only entries whose title, summary or author match are delivered" },
      exclude: { type: "string", description: "Case-insensitive regex; entries that match are skipped" },
    },
    required: ["url"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (!input.url) return { error: "url is required for a yab monitor" }

    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return { error: "url must be a valid http(s) URL" }
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "url must be a valid http(s) URL" }

    for (const [key, pattern] of [["match", input.match], ["exclude", input.exclude]] as const) {
      if (!pattern) continue
      try {
        new RegExp(pattern, "i")
      } catch {
        return { error: `${key} must be a valid regular expression` }
      }
    }

    const source: YabSourceRecord = { type: "yab", url: url.href }
    if (input.space) source.space = input.space
    if (input.match) source.match = input.match
    if (input.exclude) source.exclude = input.exclude
    return source
  },
  key: (source) => `yab:${source.space ?? ""}:${source.url}`,
  label: (source) => new URL(source.url).hostname,
  detail: (source) => ` ${shortUrl(source.url)}${source.match || source.exclude ? " · filtered" : ""}`,
  describe: (source) => `Yab feed ${shortUrl(source.url)}${source.space ? ` (${source.space})` : ""}`,
  icon: "󰖟",
  poll: async ({ source, cursor, mcp, now }) => {
    const result = await pollYab(source, cursor, (url, space) => fetchThroughYab(mcp, url, space), now)

    return {
      cursor: result.cursor,
      events: result.events.map((event) => toMonitorEvent(event, source)),
      terminal: result.terminal,
    }
  },
}

/** The monitor the daemon registers. */
export const YabMonitor = defineSource(yabSource)

function shortUrl(href: string): string {
  const url = new URL(href)
  return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
}
