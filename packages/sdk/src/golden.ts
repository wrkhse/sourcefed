import assert from "node:assert/strict"
import type { MonitorCreateInput, MonitorSource, SourceInputSchema } from "@sourcefed/core"
import { HttpError, type Http } from "./http.ts"
import { defineSource, type SourceDefinition } from "./source.ts"

/** One upstream answer the replay serves, in order. */
export type GoldenReply = { readonly status?: number; readonly body: unknown }

/** One request the plugin made, with its secrets removed. */
export type GoldenRequest = { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }

/** The create input a host passes, as the daemon builds it: the source's fields plus the monitor's name and type. */
export type GoldenCreateInput = MonitorCreateInput & { readonly name?: string; readonly sourceType?: string }

export type GoldenCase = {
  readonly name: string
  readonly build: GoldenCreateInput
  readonly cursor: unknown
  readonly replies: readonly GoldenReply[]
  readonly requests: readonly GoldenRequest[]
  readonly source: Readonly<Record<string, unknown>>
  readonly key: string
  readonly label: string
  readonly detail: string
  readonly describe: string
  readonly icon: string
  readonly schema: SourceInputSchema
  readonly events?: readonly unknown[]
  readonly cursorAfter?: unknown
  readonly terminal?: boolean
  readonly error?: string
}

/** One provider's recorded transcript: what the pre-SDK tree did, which the SDK must reproduce. */
export type GoldenFixture = {
  readonly provider: string
  readonly recordedFrom: string
  readonly base: string
  readonly cases: readonly GoldenCase[]
}

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"])
const REDACTED = "«redacted»"

export function redactHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    redacted[lower] = SECRET_HEADERS.has(lower) ? REDACTED : value
  }

  return redacted
}

export function scriptedHttp(replies: readonly GoldenReply[]): { http: Http; requests: GoldenRequest[] } {
  const requests: GoldenRequest[] = []
  let next = 0

  return {
    requests,
    http: {
      async json<T = unknown>(url: string, init?: { headers?: Readonly<Record<string, string>> }): Promise<T> {
        // Recorded before the reply is read, so a case that throws still shows what it sent.
        requests.push({ method: "GET", url, headers: redactHeaders(init?.headers) })

        const reply = replies[next]
        next += 1
        if (!reply) throw new Error(`no golden reply for ${url}`)

        if (reply.status !== undefined && reply.status >= 400) {
          throw new HttpError("status", `${reply.status} for ${url}`, reply.status)
        }

        return reply.body as T
      },
    },
  }
}

export async function assertGolden<T extends MonitorSource>(fixture: GoldenFixture, definition: SourceDefinition<T>): Promise<void> {
  for (const kase of fixture.cases) {
    const scripted = scriptedHttp(kase.replies)
    const monitor = defineSource(definition, { http: scripted.http })
    const at = `${fixture.provider} ${kase.name}`

    assert.deepEqual(monitor.build(kase.build), kase.source, `${at}: source`)

    const source = monitor.validateSource(kase.source)
    assert.equal(monitor.key(source), kase.key, `${at}: key`)
    assert.equal(monitor.label(source), kase.label, `${at}: label`)
    assert.equal(monitor.detail(source), kase.detail, `${at}: detail`)
    assert.equal(monitor.describe(source), kase.describe, `${at}: describe`)
    assert.equal(monitor.icon, kase.icon, `${at}: icon`)
    assert.deepEqual(monitor.input, kase.schema, `${at}: input schema`)

    if (kase.error !== undefined) {
      await assert.rejects(
        definition.poll({ source, cursor: kase.cursor, monitorId: "golden", http: scripted.http }),
        { message: kase.error },
        `${at}: error`,
      )
    } else {
      const result = await definition.poll({ source, cursor: kase.cursor, monitorId: "golden", http: scripted.http })

      if (kase.events === undefined) {
        assert.ok("deferred" in result, `${at}: deferred`)
      } else {
        if ("deferred" in result) assert.fail(`${at}: deferred`)
        assert.deepEqual(asJSON(result.events), kase.events, `${at}: events`)
        assert.deepEqual(asJSON(result.cursor), kase.cursorAfter, `${at}: cursor after`)
        assert.equal("terminal" in result ? result.terminal : false, kase.terminal ?? false, `${at}: terminal`)
      }
    }

    assert.deepEqual(scripted.requests, kase.requests, `${at}: requests`)
  }
}

function asJSON(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}
