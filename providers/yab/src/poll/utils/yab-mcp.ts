import { spawn } from "node:child_process"
import { PollSourceError } from "@sourcefed/core"
import type { YabPage } from "../../types"

const DEFAULT_YAB_COMMAND = "/Applications/yab.app/Contents/MacOS/yab"
const TIMEOUT_MS = 45_000

// Yab quotes the page and its own stderr back at us, and both can carry the feed's URL, whose
// path or query is often the feed's only credential. Keep the host, drop the rest.
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const MAX_QUOTED = 300

function redact(text: string, url: string | undefined): string {
  let redacted = text.replace(URL_PATTERN, (candidate) => hostOf(candidate))
  for (const part of secretParts(url)) redacted = redacted.split(part).join("")
  return redacted.slice(0, MAX_QUOTED)
}

function hostOf(candidate: string): string {
  try {
    return new URL(candidate).hostname
  } catch {
    return "the feed"
  }
}

// A bare echo of the feed's path or query, with no scheme in front of it, still names the
// credential, so the requested URL's own parts are removed as well.
function secretParts(url: string | undefined): string[] {
  if (!url) return []
  try {
    const parsed = new URL(url)
    return [parsed.pathname, parsed.search].filter((part) => part.length > 1)
  } catch {
    return []
  }
}

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
  if (!Number.isInteger(code) || code <= 0) throw new PollSourceError(`yab fetch gave an unexpected answer: ${redact(head, url)}`)
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
    const timer = setTimeout(() => finish(new PollSourceError(`yab ${name} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)

    child.on("error", (error) => finish(new PollSourceError(`yab mcp could not start (${command}): ${error.message}`)))
    child.on("exit", (code) => {
      const detail = stderr.trim() ? `: ${redact(stderr.trim(), url)}` : ""
      finish(new PollSourceError(`yab mcp exited (${code ?? "signal"}) before answering${detail}`))
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
          if (message.error) return finish(new PollSourceError(`yab mcp initialize failed: ${redact(message.error.message, url)}`))
          send({ method: "notifications/initialized" })
          send({ id: 2, method: "tools/call", params: { name, arguments: args } })
        } else if (message.id === 2) {
          if (message.error) return finish(new PollSourceError(`yab ${name} failed: ${redact(message.error.message, url)}`))
          const content: any[] = Array.isArray(message.result?.content) ? message.result.content : []
          const text = content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n")
          if (message.result?.isError) return finish(new PollSourceError(`yab ${name} failed: ${redact(text, url)}`))
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
