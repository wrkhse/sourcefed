import type { MonitorEvent, MonitorRecord } from "@sourcefed/core"
import { sourceDefinition } from "../registry.ts"

/** The most UTF-8 bytes one evidence block may hold, far under Chauffeur's 256 KiB evidence limit. */
export const MAX_BLOCK_BYTES = 16 * 1024

export type TriageEvidence = { event: string; thread: string; monitor: string }

/**
 * The text Chauffeur v2 reads for one event: an event block, the monitor's
 * description and a thread label. The blocks are text, built only from the
 * event and its monitor, and each is clamped so the whole request stays far
 * under Chauffeur's 256 KiB evidence limit.
 */
export function triageEvidence(monitor: MonitorRecord, event: MonitorEvent): TriageEvidence {
  const reportedType = (event.source as { type?: unknown } | null | undefined)?.type
  const sourceType = typeof reportedType === "string" ? reportedType : monitor.source.type

  const eventBlock = [
    `source: ${sourceType}`,
    `kind: ${event.kind}`,
    `summary: ${event.summary}`,
    `body: ${event.body ?? ""}`,
    event.actionable ? "actionable: yes" : "actionable: no (informational)",
  ].join("\n")

  return {
    event: clampBytes(eventBlock),
    thread: clampBytes(threadLabel(monitor, event)),
    monitor: clampBytes(sourceDefinition(monitor.source)?.describe(monitor.source) ?? ""),
  }
}

/** The thread label and subject title, or whichever of the two is known. */
function threadLabel(monitor: MonitorRecord, event: MonitorEvent): string {
  const label = sourceDefinition(monitor.source)?.label(monitor.source).trim() ?? ""
  const title = typeof event.subject?.title === "string" ? event.subject.title.trim() : ""

  if (label && title) return `${label}: ${title}`
  return label || title
}

/**
 * Cuts text to the longest prefix that fits in `max` UTF-8 bytes without
 * splitting a code point, so no lone surrogate or replacement character is
 * left behind. Fitting text is returned unchanged and no marker is appended.
 */
export function clampBytes(text: string, max = MAX_BLOCK_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text

  let bytes = 0
  let end = 0

  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > max) break
    bytes += size
    end += char.length
  }

  return text.slice(0, end)
}
