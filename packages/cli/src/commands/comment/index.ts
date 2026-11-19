import type { DaemonClient } from "@sourcefed/daemon"
import { connectDaemonClient, defaultDaemonUrl } from "@sourcefed/daemon"
import { issue } from "./issue.ts"

const SUBCOMMANDS: Record<string, (context: CommentContext) => Promise<void>> = {
  issue,
}

const SUBCOMMAND_NAMES = Object.keys(SUBCOMMANDS).join(", ")

export async function runComment(argv: string[]): Promise<void> {
  const [subcommand, ...args] = argv
  const client = await connectDaemonClient({
    name: "sourcefed-cli",
    url: process.env.SOURCEFED_DAEMON_URL ?? defaultDaemonUrl(),
  })
  const run = subcommand ? SUBCOMMANDS[subcommand] : undefined
  if (!run) {
    await client.close()
    throw new Error(`comment expects ${SUBCOMMAND_NAMES}`)
  }
  try {
    await run({ client, args })
  } finally {
    await client.close()
  }
}

export type CommentContext = {
  client: DaemonClient
  args: string[]
}
