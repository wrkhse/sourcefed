import { spawn } from "node:child_process"

/** Why a tool call failed, in the terms a source's own message needs. */
export type McpFailure = "start" | "timeout" | "exit" | "error" | "tool" | "overflow"

/**
 * A tool call that produced no text. `detail` is the server's own words (its stderr, or the
 * tool's failure text) and may quote what the source sent, so a source decides whether and how
 * to show it; it is never part of `message`.
 */
export class McpError extends Error {
  readonly failure: McpFailure
  readonly code?: number | string
  readonly exitCode?: number | null
  /** The command that could not start, so a source can name it without knowing the host's table. */
  readonly command?: string
  /** How long the call waited, so a source can say so without knowing the host's timeout. */
  readonly timeoutMs?: number
  /** How much output the call allowed, so a source can say so without knowing the client's limit. */
  readonly limitBytes?: number
  readonly detail: string

  constructor(
    failure: McpFailure,
    message: string,
    options: {
      readonly code?: number | string
      readonly exitCode?: number | null
      readonly command?: string
      readonly timeoutMs?: number
      readonly limitBytes?: number
      readonly detail?: string
    } = {},
  ) {
    super(message)
    this.name = "McpError"
    this.failure = failure
    this.detail = options.detail ?? ""
    if (options.code !== undefined) this.code = options.code
    if (options.exitCode !== undefined) this.exitCode = options.exitCode
    if (options.command !== undefined) this.command = options.command
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs
    if (options.limitBytes !== undefined) this.limitBytes = options.limitBytes
  }
}

/** The tools a source may call. A call answers the tool's text parts joined by newlines. */
export type Mcp = {
  call(server: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<string>
}

/** How the host runs one server: a command speaking MCP on stdio, and how long a call may take. */
export type McpServer = { readonly command: string; readonly args: readonly string[]; readonly timeoutMs: number }

type McpStream = {
  setEncoding(encoding: "utf8"): unknown
  on(event: "data", listener: (chunk: string) => void): unknown
}

/** The part of a child process the client uses, so a test can supply one without a process. */
export type McpChild = {
  readonly stdin: {
    write(chunk: string): unknown
    on(event: "error", listener: (error: Error) => void): unknown
  }
  readonly stdout: McpStream
  readonly stderr: McpStream
  on(event: "error", listener: (error: Error) => void): unknown
  on(event: "exit", listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}

export type McpSpawn = (command: string, args: readonly string[]) => McpChild

const spawnStdio: McpSpawn = (command, args) => spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] })

const DEFAULT_YAB_COMMAND = "/Applications/yab.app/Contents/MacOS/yab"

/**
 * The MCP servers the host runs, by name. Yab is the only one: its command is
 * SOURCEFED_YAB_COMMAND, read at each call, or the app's own binary. The daemon will take this
 * table from the owner's configuration.
 */
export function hostMcpServers(name: string): McpServer | undefined {
  if (name !== "yab") return undefined

  return { command: process.env.SOURCEFED_YAB_COMMAND || DEFAULT_YAB_COMMAND, args: ["mcp"], timeoutMs: 45_000 }
}

/**
 * Calls a tool over stdio: the server's command is started for the call and stopped after it,
 * so nothing stays connected between polls. A call answers only once its child has gone, so it
 * takes at most `timeoutMs + 2 × KILL_GRACE_MS`: the timeout, then SIGTERM's grace, then
 * SIGKILL's.
 */
export function stdioMcp(servers: (name: string) => McpServer | undefined, spawnChild: McpSpawn = spawnStdio): Mcp {
  return {
    call(server, tool, args) {
      const config = servers(server)

      // A source naming a server the host does not run is a configuration bug, not a failed call.
      if (!config) return Promise.reject(new Error(`no MCP server named ${server}`))

      return callTool(server, config, tool, args, spawnChild)
    },
  }
}

// One answer carries a whole page, and a server that sends this much without finishing its
// answer is broken.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

// Not the 300 characters a source quotes: a source redacts before it quotes, removing URLs and
// the request's path and query, and text cut before redaction could end inside a URL, leaving a
// credential that no longer looks like one. Keeping well more than any quote leaves redaction
// whole text to work on, while still bounding memory.
const MAX_DETAIL_CHARS = 4096

// How long a stopping child has after SIGTERM before SIGKILL, and after SIGKILL before the call
// answers anyway.
const KILL_GRACE_MS = 2_000

function callTool(server: string, config: McpServer, tool: string, args: Readonly<Record<string, unknown>>, spawnChild: McpSpawn): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: McpChild | undefined
    let buffer = ""
    let bufferBytes = 0
    let stderr = ""
    let settled = false
    let gone = false
    let delivered = false
    let outcome: { readonly error: Error | undefined; readonly value: string } | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const deliver = (): void => {
      if (delivered || !outcome) return
      delivered = true
      clearTimeout(graceTimer)
      if (outcome.error) reject(outcome.error)
      else resolve(outcome.value)
    }
    // The outcome is decided here but delivered only once the child has gone, so a server that
    // ignores SIGTERM cannot outlive the call.
    const finish = (error: Error | undefined, value = ""): void => {
      if (settled) return
      settled = true
      outcome = { error, value }
      clearTimeout(timer)
      if (gone || !child) return deliver()

      // A child may exit inside kill(); then it has gone and nothing is left to wait for.
      child.kill("SIGTERM")
      if (delivered) return
      graceTimer = setTimeout(() => {
        child?.kill("SIGKILL")
        if (delivered) return
        graceTimer = setTimeout(deliver, KILL_GRACE_MS)
      }, KILL_GRACE_MS)
    }
    const send = (message: Record<string, unknown>): void => {
      child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    }
    const timer = setTimeout(() => {
      finish(new McpError("timeout", `${server} did not answer in ${config.timeoutMs / 1000} s`, { timeoutMs: config.timeoutMs }))
    }, config.timeoutMs)
    const failedToStart = () => finish(new McpError("start", `${server} could not start (${config.command})`, { command: config.command }))

    try {
      child = spawnChild(config.command, config.args)
    } catch {
      return failedToStart()
    }

    const onLine = (line: string): void => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }

      if (message.id === 1) {
        if (message.error) return finish(rpcError(server, message.error))
        send({ method: "notifications/initialized" })
        send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } })
      } else if (message.id === 2) {
        if (message.error) return finish(rpcError(server, message.error))
        const content: any[] = Array.isArray(message.result?.content) ? message.result.content : []
        const text = content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n")
        if (message.result?.isError) return finish(new McpError("tool", `${server} reported the ${tool} failed`, { detail: text }))
        finish(undefined, text)
      }
    }

    // A child that could not start has no process to wait for: it is asked to stop, and the
    // call answers at once.
    child.on("error", () => {
      const first = !settled
      gone = true
      failedToStart()
      if (first) child?.kill("SIGTERM")
      deliver()
    })
    child.on("exit", (code) => {
      gone = true
      finish(new McpError("exit", `${server} exited (${code ?? "signal"}) before answering`, { exitCode: code, detail: stderr }))
      deliver()
    })
    child.stdin.on("error", () => {})
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_DETAIL_CHARS) stderr = (stderr + chunk).slice(0, MAX_DETAIL_CHARS)
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (settled) return
      buffer += chunk
      bufferBytes += Buffer.byteLength(chunk)
      let newline = buffer.indexOf("\n")

      while (newline >= 0 && !settled) {
        const raw = buffer.slice(0, newline + 1)
        const line = raw.trim()
        buffer = buffer.slice(newline + 1)
        bufferBytes -= Buffer.byteLength(raw)
        newline = buffer.indexOf("\n")
        if (line) onLine(line)
      }

      if (bufferBytes > MAX_OUTPUT_BYTES) {
        const mib = MAX_OUTPUT_BYTES / 1024 / 1024
        finish(new McpError("overflow", `${server} answered more than ${mib} MiB`, { limitBytes: MAX_OUTPUT_BYTES }))
      }
    })

    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sourcefed", version: "0.3" } },
    })
  })
}

// Only the code goes in the message; the server's own words may quote the request, so they are detail.
function rpcError(server: string, error: unknown): McpError {
  const fields = typeof error === "object" && error !== null ? (error as { code?: unknown; message?: unknown }) : {}
  const code = typeof fields.code === "number" || typeof fields.code === "string" ? fields.code : undefined
  const detail = typeof fields.message === "string" ? fields.message : ""
  const suffix = code === undefined ? "" : ` (code ${code})`

  return new McpError("error", `${server} answered with an error${suffix}`, { ...(code === undefined ? {} : { code }), detail })
}
