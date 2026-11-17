import net from "node:net"
import os from "node:os"
import path from "node:path"

export const PROBE_TIMEOUT_MS = 500
export const MAX_STATUS_BYTES = 64 * 1024

export type ChauffeurEndpoint = { socket: string; version: string }

const CHAUFFEUR_V2_VERSION = /^1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const STATUS_REQUEST = '{"jsonrpc":"2.0","id":1,"method":"chauffeur.status"}\n'

/**
 * Lists the sockets a Chauffeur daemon may listen on, most preferred first.
 *
 * This mirrors @fdcn/chauffeur/client's socketPath rule -- the runtime folder is $XDG_RUNTIME_DIR,
 * falling back to the temporary folder -- and will import it once that package is a dependency.
 * v1 and v2 can both be installed, so both names are tried in that order.
 */
export function candidateSockets(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  if (env.CHAUFFEUR_SOCKET) return [env.CHAUFFEUR_SOCKET]

  const runtime = env.XDG_RUNTIME_DIR || os.tmpdir()

  return [
    path.join(runtime, "chauffeur", "daemon.sock"),
    path.join(runtime, "chauffeur-next", "daemon.sock"),
  ]
}

/**
 * Whether a status result came from a Chauffeur v2 daemon. v1 reports 0.x, so major 1 excludes it.
 */
export function compatibleStatus(result: unknown): result is { protocol: 1; version: string } {
  if (typeof result !== "object" || result === null) return false

  const status = result as { protocol?: unknown; version?: unknown }

  return status.protocol === 1
    && typeof status.version === "string"
    && CHAUFFEUR_V2_VERSION.test(status.version)
}

/**
 * Asks one socket for its status. A missing socket, a daemon that closes, rejects or stays silent,
 * and any incompatible reply all resolve undefined, so callers fail open rather than throw. The
 * status reply is bounded to one line, MAX_STATUS_BYTES, and timeoutMs.
 */
export function probe(socket: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ChauffeurEndpoint | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let pending = ""
    let client: net.Socket

    try {
      client = net.createConnection(socket)
    } catch {
      resolve(undefined)
      return
    }

    const timer = setTimeout(() => finish(), timeoutMs)

    function finish(endpoint?: ChauffeurEndpoint): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.destroy()
      resolve(endpoint)
    }

    function parse(line: string): ChauffeurEndpoint | undefined {
      let reply: unknown
      try {
        reply = JSON.parse(line)
      } catch {
        return undefined
      }
      if (typeof reply !== "object" || reply === null) return undefined

      const frame = reply as { id?: unknown; result?: unknown }
      if (frame.id !== 1 || !compatibleStatus(frame.result)) return undefined

      return { socket, version: frame.result.version }
    }

    client.setEncoding("utf8")

    client.on("connect", () => client.write(STATUS_REQUEST))

    client.on("data", (chunk: Buffer | string) => {
      if (settled) return

      pending += chunk.toString()
      const newline = pending.indexOf("\n")
      if (newline === -1) {
        if (Buffer.byteLength(pending, "utf8") > MAX_STATUS_BYTES) finish()
        return
      }

      const line = pending.slice(0, newline)
      finish(Buffer.byteLength(line, "utf8") > MAX_STATUS_BYTES ? undefined : parse(line))
    })

    client.on("error", () => finish())
    client.on("close", () => finish())
  })
}

/**
 * Returns the first Chauffeur v2 daemon among the candidate sockets, probing in order. A missing,
 * v1, incompatible or silent daemon is simply not v2, so discovery fails open with undefined.
 */
export async function discover(
  env: Readonly<Record<string, string | undefined>> = process.env,
  probeSocket: (socket: string) => Promise<ChauffeurEndpoint | undefined> = probe,
): Promise<ChauffeurEndpoint | undefined> {
  for (const socket of candidateSockets(env)) {
    const endpoint = await probeSocket(socket)
    if (endpoint) return endpoint
  }

  return undefined
}
