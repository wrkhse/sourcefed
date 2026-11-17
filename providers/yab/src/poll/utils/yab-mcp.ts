import { spawn } from "node:child_process"
import { PollSourceError } from "@sourcefed/core"
import type { YabPage } from "../../types"

const DEFAULT_YAB_COMMAND = "/Applications/yab.app/Contents/MacOS/yab"
const TIMEOUT_MS = 45_000

// Yab quotes the page and its own stderr back at us, and both can carry the feed's URL, whose
// path or query is often the feed's only credential. So its words are never part of a failure
// by default: each failure below is a fixed description built from fields we parsed. Only
// SOURCEFED_DEBUG asks for the detail, and redact() is the second line of defence when it does.
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const MAX_QUOTED = 300
// A path or query shorter than this is not a credential, and removing it would mangle the text.
const MIN_SECRET = 8

/** Read a URL through Yab, with the cookies of the given space (or wherever the site is signed in). */
export async function fetchThroughYab(url: string, space?: string): Promise<YabPage> {
  const args: Record<string, unknown> = { url, html: true }
  if (space) args.space = space
  return parseYabFetch(await callYabTool("fetch", args), url)
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

/**
 * Call one tool on Yab's MCP server over stdio: `yab mcp` is started for the call and
 * stopped after it, so nothing stays connected between polls.
 */
export function callYabTool(name: string, args: Record<string, unknown>): Promise<string> {
  const command = process.env.SOURCEFED_YAB_COMMAND || DEFAULT_YAB_COMMAND
  const url = typeof args.url === "string" ? args.url : undefined

  return new Promise((resolve, reject) => {
    const child = spawn(command, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let stderr = ""
    let settled = false

    const finish = (error: Error | undefined, value = ""): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    }
    const timer = setTimeout(() => finish(new PollSourceError(`Yab did not answer in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)

    child.on("error", () => finish(new PollSourceError(`Yab could not start (${command})`)))
    child.on("exit", (code) => {
      finish(new PollSourceError(`Yab exited (${code ?? "signal"}) before answering${detail(stderr, url)}`))
    })
    child.stdin.on("error", () => {})
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (!line) continue

        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          if (message.error) return finish(new PollSourceError(`Yab answered with an error${errorCode(message.error)}`))
          send({ method: "notifications/initialized" })
          send({ id: 2, method: "tools/call", params: { name, arguments: args } })
        } else if (message.id === 2) {
          if (message.error) return finish(new PollSourceError(`Yab answered with an error${errorCode(message.error)}`))
          const content: any[] = Array.isArray(message.result?.content) ? message.result.content : []
          const text = content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n")
          if (message.result?.isError) return finish(new PollSourceError(`Yab reported the ${name} failed${detail(text, url)}`))
          return finish(undefined, text)
        }
      }
    })

    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sourcefed", version: "0.3" } },
    })
  })
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

// A JSON-RPC error carries a code and sometimes a message; only the code is safe to quote, and
// the error may not be an object at all.
function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return ""
  const code = (error as { code?: unknown }).code
  return typeof code === "number" || typeof code === "string" ? ` (code ${code})` : ""
}

function debugEnabled(): boolean {
  const value = process.env.SOURCEFED_DEBUG?.trim().toLowerCase()
  return Boolean(value) && value !== "0" && value !== "false"
}
