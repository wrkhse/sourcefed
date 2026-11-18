import { spawn } from "node:child_process"

/** Why a tool call failed, in the terms a source's own message needs. */
export type McpFailure = "start" | "timeout" | "exit" | "error" | "tool"

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
  readonly detail: string

  constructor(
    failure: McpFailure,
    message: string,
    options: {
      readonly code?: number | string
      readonly exitCode?: number | null
      readonly command?: string
      readonly timeoutMs?: number
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
  kill(): unknown
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
 * so nothing stays connected between polls.
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

function callTool(server: string, config: McpServer, tool: string, args: Readonly<Record<string, unknown>>, spawnChild: McpSpawn): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: McpChild | undefined
    let buffer = ""
    let stderr = ""
    let settled = false

    const finish = (error: Error | undefined, value = ""): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.kill()
      if (error) reject(error)
      else resolve(value)
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

    child.on("error", failedToStart)
    child.on("exit", (code) => {
      finish(new McpError("exit", `${server} exited (${code ?? "signal"}) before answering`, { exitCode: code, detail: stderr }))
    })
    child.stdin.on("error", () => {})
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")

      while (newline >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (line) onLine(line)
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
