import type { MonitorContext } from "#sourcefed/types"
import type { Monitor } from "../../monitor"
import type { MonitorRecord } from "../../types"
import { isPollSourceError } from "../types/poll-source-error.ts"

const MAX_IDENTITY = 80
const MAX_MESSAGE = 200
const MAX_LINE = 300

export async function tick(context: MonitorContext): Promise<void> {
  const monitors = await context.service.list()
  for (const record of monitors) {
    if (!record.enabled) continue
    const source = context.sources[record.source.type] as Monitor | undefined
    if (!source) {
      console.error(oneLine(`[sourcefed] monitor ${record.id}: no monitor provider for source type ${record.source.type}`, MAX_LINE))
      continue
    }
    try {
      await source.tick(context, record)
    } catch (error) {
      logFailure(record, source, "poll failed", error)
      await context.service.updateCursor(record, "__lastAttemptAt", Date.now()).catch((updateError) => {
        logFailure(record, source, "poll timestamp update failed", updateError)
      })
    }
  }
}

// A monitor that keeps failing repeats its failure every interval, so a failure the source
// expects — a PollSourceError — is one line. A bug keeps its message and stack, and
// SOURCEFED_DEBUG prints the stack for an expected failure too.
function logFailure(record: MonitorRecord, source: Monitor, what: string, error: unknown): void {
  const expected = isPollSourceError(error)
  const line = oneLine(
    `[sourcefed] monitor ${record.id} (${describeSource(record, source)}) ${what}: ${describeError(error)}`,
    MAX_LINE,
  )
  if (expected && !debugEnabled()) {
    console.error(line)
    return
  }
  console.error(line, error)
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error), MAX_MESSAGE)
  const message = oneLine(error.message, MAX_MESSAGE)
  const cause = error.cause instanceof Error && !message.includes(error.cause.message)
    ? ` (cause: ${oneLine(error.cause.message, MAX_MESSAGE)})`
    : ""
  return `${message}${cause}`
}

// The label is the source's display string — the one `monitor list` already shows — used
// instead of the cursor key so a monitor's line names it the way the CLI does.
function describeSource(record: MonitorRecord, source: Monitor): string {
  try {
    const label = oneLine(source.label(source.validateSource(record.source)), MAX_IDENTITY)
    return `${record.source.type} ${label}`.trim()
  } catch {
    return record.source.type
  }
}

// Upstream answers and stored cursors carry newlines and can be long; one failure is still
// one readable line.
function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, " ").trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

function debugEnabled(): boolean {
  const value = process.env.SOURCEFED_DEBUG?.trim().toLowerCase()
  return Boolean(value) && value !== "0" && value !== "false"
}
