import { PollSourceError } from "@sourcefed/core"
import type { YabCursor, YabEvent, YabPage, YabSourceRecord } from "../../types"
import { feedEvents } from "./feed-events.ts"
import { parseFeed } from "./parse-feed.ts"

export type YabFetcher = (url: string, space?: string) => Promise<YabPage>

function feedHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return "the feed"
  }
}

export async function pollYab(
  source: YabSourceRecord,
  cursorRaw: unknown,
  fetchPage: YabFetcher,
  now: () => Date,
): Promise<{ events: YabEvent[]; cursor: YabCursor; terminal: false }> {
  const page = await fetchPage(source.url, source.space)
  if (page.status >= 400) {
    const hint = page.status === 401 || page.status === 403 ? "; sign in to the site in Yab" : ""
    throw new PollSourceError(`yab fetch of ${feedHost(source.url)} answered ${page.status}${hint}`)
  }
  return { ...feedEvents(source, parseFeed(page.body, page.type), cursorRaw, now), terminal: false }
}
