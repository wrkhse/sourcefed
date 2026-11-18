import { PollSourceError } from "@sourcefed/core"
import { McpError, type Mcp } from "@sourcefed/sdk"
import type { YabPage } from "../../types"

// Yab quotes the page and its own stderr back at us, and both can carry the feed's URL, whose
// path or query is often the feed's only credential. So its words are never part of a failure
// by default: each failure below is a fixed description built from fields we parsed. Only
// SOURCEFED_DEBUG asks for the detail, and redact() is the second line of defence when it does.
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const MAX_QUOTED = 300
// A path or query shorter than this is not a credential, and removing it would mangle the text.
const MIN_SECRET = 8

/** Read a URL through Yab, with the cookies of the given space (or wherever the site is signed in). */
export async function fetchThroughYab(mcp: Mcp, url: string, space?: string): Promise<YabPage> {
  const args: Record<string, unknown> = { url, html: true }
  if (space) args.space = space

  let text: string
  try {
    text = await mcp.call("yab", "fetch", args)
  } catch (error) {
    throw yabFailure(error, url)
  }

  return parseYabFetch(text, url)
}

/** Yab's fetch answers `STATUS · TYPE · URL`, a blank line, then the body. */
export function parseYabFetch(text: string, url?: string): YabPage {
  const split = text.indexOf("\n\n")
  const head = split >= 0 ? text.slice(0, split) : text
  const body = split >= 0 ? text.slice(split + 2) : ""
  const [status = "", type = "", ...rest] = head.split(" · ")
  const code = Number(status.trim())
  if (!Number.isInteger(code) || code <= 0) throw new PollSourceError(`Yab's answer was not the expected shape${detail(head, url)}`)
  return { status: code, type: type.trim(), url: rest.join(" · ").trim(), body }
}

// The host's failure in Yab's own words, as the provider has always worded them. Anything that
// is not a failed call, such as the host not running Yab at all, is a bug and passes through.
function yabFailure(error: unknown, url: string): unknown {
  if (!(error instanceof McpError)) return error

  switch (error.failure) {
    case "start":
      return new PollSourceError(`Yab could not start (${error.command})`)
    case "timeout":
      return new PollSourceError(`Yab did not answer in ${(error.timeoutMs ?? 0) / 1000} s`)
    case "exit":
      return new PollSourceError(`Yab exited (${error.exitCode ?? "signal"}) before answering${detail(error.detail, url)}`)
    case "error":
      return new PollSourceError(`Yab answered with an error${errorCode(error.code)}`)
    case "tool":
      return new PollSourceError(`Yab reported the fetch failed${detail(error.detail, url)}`)
  }
}

// Yab's own words, only when the operator asked for them, redacted and bounded.
function detail(text: unknown, url: string | undefined): string {
  if (!debugEnabled()) return ""
  const quoted = redact(text, url)
  return quoted ? `: ${quoted}` : ""
}

function redact(text: unknown, url: string | undefined): string {
  const source = typeof text === "string" ? text : text === undefined || text === null ? "" : String(text)
  let redacted = source.replace(URL_PATTERN, (candidate) => hostOf(candidate))
  for (const part of secretParts(url)) redacted = redacted.split(part).join("")
  return redacted.slice(0, MAX_QUOTED).trim()
}

function hostOf(candidate: string): string {
  try {
    return new URL(candidate).hostname
  } catch {
    return "the feed"
  }
}

// A bare echo of the feed's path or query, with no scheme in front of it, still names the
// credential: remove the requested URL's own parts too.
function secretParts(url: string | undefined): string[] {
  if (!url) return []
  try {
    const parsed = new URL(url)
    return [parsed.pathname, parsed.search].filter((part) => part.length >= MIN_SECRET)
  } catch {
    return []
  }
}

// A JSON-RPC error's message may quote the request, so only its code is quoted, and an error
// without one is named by nothing.
function errorCode(code: number | string | undefined): string {
  return code === undefined ? "" : ` (code ${code})`
}

function debugEnabled(): boolean {
  const value = process.env.SOURCEFED_DEBUG?.trim().toLowerCase()
  return Boolean(value) && value !== "0" && value !== "false"
}
