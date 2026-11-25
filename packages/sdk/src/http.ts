/** Why one request failed, in the terms a plugin's own error message needs. */
export type HttpFailure = "transport" | "status" | "body";

/** A request that did not produce JSON. A plugin decides what its own message says. */
export class HttpError extends Error {
  readonly failure: HttpFailure;
  readonly status?: number;

  constructor(failure: HttpFailure, message: string, status?: number) {
    super(message);
    this.name = "HttpError";
    this.failure = failure;
    if (status !== undefined) this.status = status;
  }
}

/** One request as a source sends it. */
export type HttpRequest = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
};

/**
 * The only network a source has. `fetch` answers as the upstream answered, and a transport
 * failure rejects exactly as fetch does, so a provider keeps its own status, header and error
 * handling; `json` reduces a request to its JSON or one of three failures.
 */
export type Http = {
  fetch(url: string, init?: HttpRequest): Promise<Response>;
  json<T = unknown>(url: string, init?: HttpRequest): Promise<T>;
};

/** An `Http` over one way of sending a request, so the host and the replay share `json`'s rule. */
export function httpOver(
  send: (url: string, init?: HttpRequest) => Promise<Response>,
): Http {
  return {
    fetch: send,
    async json<T = unknown>(url: string, init?: HttpRequest): Promise<T> {
      let response: Response;
      try {
        response = await send(url, init);
      } catch (error) {
        throw new HttpError(
          "transport",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!response.ok)
        throw new HttpError(
          "status",
          `${response.status} for ${url}`,
          response.status,
        );
      try {
        return (await response.json()) as T;
      } catch {
        throw new HttpError("body", `a body that is not JSON from ${url}`);
      }
    },
  };
}

/**
 * The host's transport. Without an argument it calls whatever `globalThis.fetch` is at the
 * moment of each request, as the providers did before the SDK, so a test that replaces fetch
 * after a source is defined is still the one answering.
 */
export function fetchHttp(fetchImpl?: typeof fetch): Http {
  return httpOver((url, init) => (fetchImpl ?? globalThis.fetch)(url, init));
}
