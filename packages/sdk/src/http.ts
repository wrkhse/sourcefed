/** Why one request failed, in the terms a plugin's own error message needs. */
export type HttpFailure = "transport" | "status" | "body"

/** A request that did not produce JSON. A plugin decides what its own message says. */
export class HttpError extends Error {
  readonly failure: HttpFailure
  readonly status?: number

  constructor(failure: HttpFailure, message: string, status?: number) {
    super(message)
    this.name = "HttpError"
    this.failure = failure
    if (status !== undefined) this.status = status
  }
}

/**
 * The only network a plugin has. The host decides where a request may go and which secret
 * it may carry; today it is a plain fetch, and the broker replaces it once barn owns the network.
 */
export type Http = {
  json<T = unknown>(url: string, init?: { headers?: Readonly<Record<string, string>> }): Promise<T>
}

/** The host's transport: fetch, with failures reduced to the three a plugin must tell apart. */
export function fetchHttp(fetchImpl: typeof fetch = fetch): Http {
  return {
    async json<T = unknown>(url: string, init?: { headers?: Readonly<Record<string, string>> }): Promise<T> {
      let response: Response
      try {
        response = await fetchImpl(url, { headers: init?.headers })
      } catch (error) {
        throw new HttpError("transport", error instanceof Error ? error.message : String(error))
      }
      if (!response.ok) throw new HttpError("status", `${response.status} for ${url}`, response.status)
      try {
        return (await response.json()) as T
      } catch {
        throw new HttpError("body", `a body that is not JSON from ${url}`)
      }
    },
  }
}
