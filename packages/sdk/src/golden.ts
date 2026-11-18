import assert from "node:assert/strict"
import type { MonitorCreateInput, MonitorSource, SourceInputSchema, WebhookMonitor } from "@sourcefed/core"
import { httpOver, type Http, type HttpRequest } from "./http.ts"
import { defineSource, type SourceDefinition } from "./source.ts"

/** One upstream answer the replay serves, in order. */
export type GoldenReply = {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** A plain-text body, such as a job log, served as it is instead of as JSON. */
  readonly text?: string
}

/** One request the plugin made, with its secrets removed, and its body when it sent a string (a GraphQL POST). */
export type GoldenRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** The create input a host passes, as the daemon builds it: the source's fields plus the monitor's name and type. */
export type GoldenCreateInput = MonitorCreateInput & { readonly name?: string; readonly sourceType?: string }

export type GoldenCase = {
  readonly name: string
  /** The instant this case ran at, as an ISO instant; it overrides the fixture's `now`. */
  readonly now?: string
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
  readonly deferred?: true
}

/** One delivery to the source's webhook: the request as it arrived, and what each step made of it. */
export type GoldenWebhookCase = {
  readonly name: string
  /** The instant this delivery arrived at, as an ISO instant; it overrides the fixture's `now`. */
  readonly now?: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly cursor: unknown
  readonly verified: boolean
  readonly challenge?: Readonly<Record<string, string>> | null
  readonly deliveryId?: string | null
  readonly eventName?: string
  readonly event?: unknown
  readonly cursorAfter?: unknown
}

/** The source's webhook as the old tree declared it, and the deliveries it was given. */
export type GoldenWebhook = {
  readonly path: string
  readonly preferred: boolean
  readonly acknowledgeBeforeDelivery: boolean
  readonly configured: boolean
  readonly cases: readonly GoldenWebhookCase[]
}

/** One provider's recorded transcript: what the pre-SDK tree did, which the SDK must reproduce. */
export type GoldenFixture = {
  readonly provider: string
  readonly recordedFrom: string
  readonly base: string
  /** The clock the recording ran at, and the clock the replay gives the source, as an ISO instant. */
  readonly now?: string
  readonly cases: readonly GoldenCase[]
  readonly webhook?: GoldenWebhook
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

/** The one rule the recorder and the replay both answer a request with, so the two cannot drift. */
export function replyResponse(reply: GoldenReply): Response {
  const status = reply.status ?? 200

  // A 204 or 304 may not carry a body, so it gets only the headers the reply recorded.
  if (status === 204 || status === 304) {
    return new Response(null, { status, headers: { ...reply.headers } })
  }

  if (reply.text !== undefined) {
    return new Response(reply.text, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", ...reply.headers },
    })
  }

  return new Response(JSON.stringify(reply.body ?? null), {
    status,
    headers: { "content-type": "application/json", ...reply.headers },
  })
}

/**
 * A request as the transcript records it. The body is kept only when it is a string, so a
 * GET's record has no `body` key and every fixture recorded before bodies keeps its bytes.
 */
export function goldenRequest(url: string, init?: HttpRequest): GoldenRequest {
  const request = { method: init?.method ?? "GET", url, headers: redactHeaders(init?.headers) }

  return typeof init?.body === "string" ? { ...request, body: init.body } : request
}

export function scriptedHttp(replies: readonly GoldenReply[]): { http: Http; requests: GoldenRequest[] } {
  const requests: GoldenRequest[] = []
  let next = 0

  const http = httpOver(async (url, init) => {
    // Recorded before the reply is read, so a case that throws still shows what it sent.
    requests.push(goldenRequest(url, init))

    const reply = replies[next]
    next += 1
    if (!reply) throw new Error(`no golden reply for ${url}`)

    return replyResponse(reply)
  })

  return { http, requests }
}

export async function assertGolden<T extends MonitorSource>(fixture: GoldenFixture, definition: SourceDefinition<T>): Promise<void> {
  for (const kase of fixture.cases) {
    const now = clockAt(kase.now ?? fixture.now)
    const scripted = scriptedHttp(kase.replies)
    const monitor = defineSource(definition, { http: scripted.http, now })
    const at = `${fixture.provider} ${kase.name}`

    assert.deepEqual(monitor.build(kase.build), kase.source, `${at}: source`)

    const source = monitor.validateSource(kase.source)
    assert.equal(monitor.key(source), kase.key, `${at}: key`)
    assert.equal(monitor.label(source), kase.label, `${at}: label`)
    assert.equal(monitor.detail(source), kase.detail, `${at}: detail`)
    assert.equal(monitor.describe(source), kase.describe, `${at}: describe`)
    assert.equal(monitor.icon, kase.icon, `${at}: icon`)
    assert.deepEqual(monitor.input, kase.schema, `${at}: input schema`)

    // A recorded `null` is a first poll, which the runtime gives as an absent cursor.
    const cursor = kase.cursor === null ? undefined : kase.cursor
    const poll = () => definition.poll({ source, cursor, monitorId: "golden", http: scripted.http, now })

    if (kase.error !== undefined) {
      await assert.rejects(poll(), { message: kase.error }, `${at}: error`)
    } else if (kase.deferred) {
      const result = await poll()
      assert.ok("deferred" in result, `${at}: deferred`)
    } else {
      const result = await poll()
      if ("deferred" in result) assert.fail(`${at}: deferred`)

      assert.deepEqual(asJSON(result.events), kase.events, `${at}: events`)
      assert.deepEqual(asJSON(result.cursor), kase.cursorAfter, `${at}: cursor after`)
      assert.equal("terminal" in result ? result.terminal : false, kase.terminal ?? false, `${at}: terminal`)
    }

    assert.deepEqual(scripted.requests, kase.requests, `${at}: requests`)
  }

  if (fixture.webhook) assertGoldenWebhook(fixture, fixture.webhook, definition)
}

function assertGoldenWebhook<T extends MonitorSource>(fixture: GoldenFixture, recorded: GoldenWebhook, definition: SourceDefinition<T>): void {
  const at = `${fixture.provider} webhook`
  // Each delivery gets a monitor of its own, as each poll case does, so it sees its own instant.
  const webhookAt = (instant?: string) => defineSource(definition, { http: scriptedHttp([]).http, now: clockAt(instant) }).webhook
  const webhook = webhookAt(fixture.now)

  if (!webhook) assert.fail(`${at}: missing`)

  assert.equal(webhook.path, recorded.path, `${at}: path`)
  assert.equal(webhook.preferred, recorded.preferred, `${at}: preferred`)
  assert.equal(webhook.acknowledgeBeforeDelivery, recorded.acknowledgeBeforeDelivery, `${at}: acknowledge before delivery`)
  assert.equal(webhook.configured(), recorded.configured, `${at}: configured`)

  for (const kase of recorded.cases) {
    const delivered = webhookAt(kase.now ?? fixture.now)
    if (!delivered) assert.fail(`${at}: missing`)

    assert.deepEqual(webhookSteps(delivered, kase, recorded.path), kase, `${at} ${kase.name}`)
  }
}

/** A recorded instant's clock, or the real one when nothing was recorded. */
function clockAt(instant?: string): () => Date {
  return instant === undefined ? () => new Date() : () => new Date(instant)
}

/**
 * What core's handleWebhook would make of one delivery, step by step, stopping where it
 * stops: verification, the challenge, the delivery id, the event name, the parsed event,
 * and the cursor the webhook would write.
 */
export function webhookSteps(
  webhook: WebhookMonitor<any>,
  delivery: {
    readonly name: string
    readonly now?: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly cursor: unknown
  },
  path: string,
): GoldenWebhookCase {
  const request = new Request("http://localhost" + path, { method: "POST", headers: delivery.headers, body: delivery.body })
  // `now` is recorded only when the delivery has one, so a fixture without it keeps its bytes.
  const instant = delivery.now === undefined ? {} : { now: delivery.now }
  const arrived = { name: delivery.name, ...instant, headers: delivery.headers, body: delivery.body, cursor: delivery.cursor }

  if (!webhook.verify(delivery.body, request)) return { ...arrived, verified: false }

  // handleWebhook answers 400 to a body that is not JSON, so nothing after verification runs.
  let payload: unknown
  try {
    payload = JSON.parse(delivery.body)
  } catch {
    return { ...arrived, verified: true }
  }

  const challenge = webhook.challenge?.(payload) ?? null
  if (challenge) return { ...arrived, verified: true, challenge }

  const deliveryId = webhook.deliveryId(request, payload) ?? null
  if (!deliveryId) return { ...arrived, verified: true, challenge, deliveryId }

  const eventName = webhook.eventName(request, payload)
  const event = webhook.parse(payload, eventName, deliveryId)
  // A recorded `null` is a monitor with no cursor yet, which the store gives as absent, as polls do.
  const cursor = delivery.cursor === null ? undefined : delivery.cursor
  const cursorAfter = event && webhook.updateCursor ? asJSON(webhook.updateCursor(event, cursor)) : null

  return { ...arrived, verified: true, challenge, deliveryId, eventName, event: asJSON(event), cursorAfter }
}

/**
 * Runs with these variables set (undefined removes one) and puts every one back afterwards,
 * so a golden test's environment does not leak into the tests that run after it.
 */
export async function withEnvironment<T>(variables: Readonly<Record<string, string | undefined>>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()

  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, process.env[name])
    setVariable(name, value)
  }

  try {
    return await run()
  } finally {
    for (const [name, value] of previous) setVariable(name, value)
  }
}

function setVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function asJSON(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}
