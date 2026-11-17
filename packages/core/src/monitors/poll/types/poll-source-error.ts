/**
 * A poll the source could not complete: an upstream answer, a missing credential, a body
 * that is not a feed. A monitor that keeps failing repeats it every interval, so it is
 * logged as one line. Anything else a source throws is a bug and keeps its stack.
 *
 * Every bundle carries its own copy of this class (scripts/build.mjs bundles each provider
 * with only node:* external), so one copy cannot tell another's failure by instanceof. The
 * brand is the cross-package contract: Symbol.for is one symbol in the whole process, and
 * isPollSourceError is how a bundle recognises a failure thrown by another.
 */
const POLL_SOURCE_ERROR = Symbol.for("sourcefed.pollSourceError")

export class PollSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PollSourceError"
    ;(this as unknown as Record<symbol, boolean>)[POLL_SOURCE_ERROR] = true
  }
}

export function isPollSourceError(value: unknown): value is PollSourceError {
  if (typeof value !== "object" || value === null) return false
  return (value as Record<symbol, unknown>)[POLL_SOURCE_ERROR] === true
}
