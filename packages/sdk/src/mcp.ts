import { spawn } from "node:child_process"

/** Why a tool call failed, in the terms a source's own message needs. */
export type McpFailure = "start" | "broken" | "timeout" | "exit" | "error" | "tool" | "overflow"

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
  removeListener(event: "data", listener: (chunk: string) => void): unknown
}

/** The part of a child process the client uses, so a test can supply one without a process. */
export type McpChild = {
  readonly stdin: {
    write(chunk: string): unknown
    on(event: "error", listener: (error: Error) => void): unknown
  }
  readonly stdout: McpStream
  readonly stderr: McpStream
  on(event: "spawn", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  on(event: "exit", listener: (code: number | null) => void): unknown
  removeListener(event: "spawn", listener: () => void): unknown
  removeListener(event: "error", listener: (error: Error) => void): unknown
  removeListener(event: "exit", listener: (code: number | null) => void): unknown
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
    new ToolCall(server, config, tool, args, resolve, reject).start(spawnChild)
  })
}

type Outcome = { readonly error: Error | undefined; readonly value: string }

/**
 * One tool call: the protocol turns the child's output into the next message or an outcome, the
 * lifetime stops the child, and the outcome is decided once and delivered once the child has gone.
 */
class ToolCall {
  private readonly server: string
  private readonly config: McpServer
  private readonly tool: string
  private readonly args: Readonly<Record<string, unknown>>
  private readonly resolve: (value: string) => void
  private readonly reject: (error: Error) => void
  private readonly timer: ReturnType<typeof setTimeout>
  private child: McpChild | undefined
  private buffer = ""
  private bufferBytes = 0
  private stderr = ""
  private started = false
  private settled = false
  private gone = false
  private delivered = false
  private outcome: Outcome | undefined
  private graceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    server: string,
    config: McpServer,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    resolve: (value: string) => void,
    reject: (error: Error) => void,
  ) {
    this.server = server
    this.config = config
    this.tool = tool
    this.args = args
    this.resolve = resolve
    this.reject = reject
    this.timer = setTimeout(() => {
      this.finish(new McpError("timeout", `${server} did not answer in ${config.timeoutMs / 1000} s`, { timeoutMs: config.timeoutMs }))
    }, config.timeoutMs)
  }

  start(spawnChild: McpSpawn): void {
    try {
      this.child = spawnChild(this.config.command, this.config.args)
    } catch {
      return this.failedToStart()
    }

    const child = this.child
    child.on("spawn", this.onSpawn)
    child.on("error", this.onError)
    child.on("exit", this.onExit)
    child.stdin.on("error", ignore)
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", this.onStderr)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", this.onStdout)

    this.send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sourcefed", version: "0.3" } },
    })
  }

  // The protocol.

  private send(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  }

  private readonly onStdout = (chunk: string): void => {
    this.started = true
    if (this.settled) return
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk)
    let newline = this.buffer.indexOf("\n")

    while (newline >= 0 && !this.settled) {
      const raw = this.buffer.slice(0, newline + 1)
      const line = raw.trim()
      this.buffer = this.buffer.slice(newline + 1)
      this.bufferBytes -= Buffer.byteLength(raw)
      newline = this.buffer.indexOf("\n")
      if (line) this.onLine(line)
    }

    if (this.bufferBytes > MAX_OUTPUT_BYTES) {
      const mib = MAX_OUTPUT_BYTES / 1024 / 1024
      this.finish(new McpError("overflow", `${this.server} answered more than ${mib} MiB`, { limitBytes: MAX_OUTPUT_BYTES }))
    }
  }

  private onLine(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id === 1) {
      if (message.error) return this.finish(rpcError(this.server, message.error))
      this.send({ method: "notifications/initialized" })
      this.send({ id: 2, method: "tools/call", params: { name: this.tool, arguments: this.args } })
    } else if (message.id === 2) {
      if (message.error) return this.finish(rpcError(this.server, message.error))
      const content: any[] = Array.isArray(message.result?.content) ? message.result.content : []
      const text = content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n")
      if (message.result?.isError) return this.finish(new McpError("tool", `${this.server} reported the ${this.tool} failed`, { detail: text }))
      this.finish(undefined, text)
    }
  }

  // The child's lifetime.

  private failedToStart(): void {
    this.finish(new McpError("start", `${this.server} could not start (${this.config.command})`, { command: this.config.command }))
  }

  private readonly onSpawn = (): void => {
    this.started = true
  }

  private readonly onError = (error: Error): void => {
    // A child that has started is a process still: the call fails, then stops it and waits as
    // any settled call does.
    if (this.started) return this.finish(new McpError("broken", `${this.server} failed while answering`, { detail: error.message }))

    // A child that could not start has no process to wait for: it is asked to stop, and the
    // call answers at once.
    const first = !this.settled
    this.gone = true
    this.failedToStart()
    if (first) this.child?.kill("SIGTERM")
    this.deliver()
  }

  private readonly onExit = (code: number | null): void => {
    this.gone = true
    this.finish(new McpError("exit", `${this.server} exited (${code ?? "signal"}) before answering`, { exitCode: code, detail: this.stderr }))
    this.deliver()
  }

  private readonly onStderr = (chunk: string): void => {
    this.started = true
    if (this.stderr.length < MAX_DETAIL_CHARS) this.stderr = (this.stderr + chunk).slice(0, MAX_DETAIL_CHARS)
  }

  // Once the call has answered the child is dropped, so nothing it does afterwards reaches the
  // call. Only the call's own listeners go: removeAllListeners would also take node's, which
  // its "close" event counts on. An error with no listener throws, so a late one is ignored.
  private detach(): void {
    const child = this.child
    if (!child) return
    child.removeListener("spawn", this.onSpawn)
    child.removeListener("error", this.onError)
    child.removeListener("exit", this.onExit)
    child.stdout.removeListener("data", this.onStdout)
    child.stderr.removeListener("data", this.onStderr)
    child.on("error", ignore)
  }

  // The outcome.

  // The outcome is decided here but delivered only once the child has gone, so a server that
  // ignores SIGTERM cannot outlive the call.
  private finish(error: Error | undefined, value = ""): void {
    if (this.settled) return
    this.settled = true
    this.outcome = { error, value }
    clearTimeout(this.timer)
    if (this.gone || !this.child) return this.deliver()

    // A child may exit inside kill(); then it has gone and nothing is left to wait for.
    this.child.kill("SIGTERM")
    if (this.delivered) return
    this.graceTimer = setTimeout(() => {
      this.child?.kill("SIGKILL")
      if (this.delivered) return
      this.graceTimer = setTimeout(() => this.deliver(), KILL_GRACE_MS)
    }, KILL_GRACE_MS)
  }

  private deliver(): void {
    if (this.delivered || !this.outcome) return
    this.delivered = true
    clearTimeout(this.graceTimer)
    this.detach()
    if (this.outcome.error) this.reject(this.outcome.error)
    else this.resolve(this.outcome.value)
  }
}

// A stopped child's pipe may still fail a write, and an error event with no listener throws.
function ignore(): void {}

// Only the code goes in the message; the server's own words may quote the request, so they are detail.
function rpcError(server: string, error: unknown): McpError {
  const fields = typeof error === "object" && error !== null ? (error as { code?: unknown; message?: unknown }) : {}
  const code = typeof fields.code === "number" || typeof fields.code === "string" ? fields.code : undefined
  const detail = typeof fields.message === "string" ? fields.message : ""
  const suffix = code === undefined ? "" : ` (code ${code})`

  return new McpError("error", `${server} answered with an error${suffix}`, { ...(code === undefined ? {} : { code }), detail })
}
