import type { MonitorContext } from "#sourcefed/types"
import type { Monitor } from "../../monitor"
import type { MonitorRecord } from "../../types"

export async function tick(context: MonitorContext): Promise<void> {
  const monitors = await context.service.list()
  for (const record of monitors) {
    if (!record.enabled) continue
    const source = context.sources[record.source.type] as Monitor | undefined
    if (!source) {
      console.error(`[sourcefed] no monitor provider for source type ${record.source.type}`)
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

// A monitor that keeps failing repeats its failure every poll interval, so one line carries
// the message. The stack is kept for a thrown value that is not an Error, and when
// SOURCEFED_DEBUG is set, because those are what make an unexpected failure diagnosable.
function logFailure(record: MonitorRecord, source: Monitor, what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const line = `[sourcefed] monitor ${record.id} (${describeSource(record, source)}) ${what}: ${message}`
  if (error instanceof Error && !debugEnabled()) {
    console.error(line)
    return
  }
  console.error(line, error)
}

// A source's key names the thing it watches as `type:identity`, which every provider keeps
// stable, so the line reads `(github wrkhse/x#1)` without adding a provider hook for logging.
function describeSource(record: MonitorRecord, source: Monitor): string {
  try {
    const key = source.key(source.validateSource(record.source))
    const prefix = `${record.source.type}:`
    return `${record.source.type} ${key.startsWith(prefix) ? key.slice(prefix.length) : key}`.trim()
  } catch {
    return record.source.type
  }
}

function debugEnabled(): boolean {
  const value = process.env.SOURCEFED_DEBUG?.trim().toLowerCase()
  return Boolean(value) && value !== "0" && value !== "false"
}
