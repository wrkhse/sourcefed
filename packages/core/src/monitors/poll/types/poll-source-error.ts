/**
 * A poll the source could not complete: an upstream answer, a missing credential, a body
 * that is not a feed. A monitor that keeps failing repeats it every interval, so it is
 * logged as one line. Anything else a source throws is a bug and keeps its stack.
 */
export class PollSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PollSourceError"
  }
}
