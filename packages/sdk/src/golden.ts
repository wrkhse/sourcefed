import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { MonitorCreateInput, MonitorSource, SourceInputSchema, WebhookMonitor } from "@sourcefed/core"
import { httpOver, type Http } from "./http.ts"
import * as v from "valibot"
import { stdioMcp, type McpChild, type McpSpawn } from "./mcp.ts"
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

/** One answer the recorded server gives a tool call: its text, a tool failure, or a JSON-RPC error. */
export type GoldenMcpReply = {
  readonly text?: string
  readonly isError?: boolean
  readonly error?: { readonly code?: number | string; readonly message?: string }
}

/** One tool call the source made. */
export type GoldenMcpCall = { readonly tool: string; readonly arguments: unknown }

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
  readonly mcpReplies?: readonly GoldenMcpReply[]
  readonly mcpCalls?: readonly GoldenMcpCall[]
  readonly source: Readonly<Record<string, unknown>>
  readonly key: string
  readonly label: string
  readonly detail: string
  readonly describe: string
  readonly icon: string
  readonly defaultPollIntervalSec?: number
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
 * A form body is kept as its string, the bytes fetch sends for it, so a provider that passed
 * fetch `URLSearchParams` records the same request as one that sends the encoded string.
 */
export function goldenRequest(
  url: string,
  init?: { method?: string; headers?: Readonly<Record<string, string>>; body?: unknown },
): GoldenRequest {
  const request = { method: init?.method ?? "GET", url, headers: redactHeaders(init?.headers) }

  if (typeof init?.body === "string") return { ...request, body: init.body }
  if (init?.body instanceof URLSearchParams) return { ...request, body: String(init.body) }

  return request
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

/**
 * A server that answers MCP over in-memory streams: initialize, then each tools/call with the
 * next reply, recording the call. Running out of replies is a fixture bug: the fake answers a
 * JSON-RPC error with code "golden:no-reply" and marks itself so the harness fails loudly.
 */
export function fakeMcpSpawn(replies: readonly GoldenMcpReply[], calls: GoldenMcpCall[]): McpSpawn & { readonly missing: boolean } {
  let next = 0
  let missing = false

  const spawn = (): McpChild => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    // Killing it exits it, as a real server would, so a call over the fake still settles.
    const kill = () => {
      if (child.killed) return
      child.killed = true
      process.nextTick(() => child.emit("exit", null))
    }
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, killed: false, kill })
    // Answered on the next tick, as a real server's line arrives after the write, so the client never re-enters itself.
    const answer = (message: Record<string, unknown>) => process.nextTick(() => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
    let buffer = ""

    stdin.setEncoding("utf8")
    stdin.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")

      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")

        if (message.method === "initialize") {
          answer({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "golden", version: "0" } } })
        } else if (message.method === "tools/call") {
          calls.push({ tool: message.params?.name, arguments: message.params?.arguments })
          answer({ id: message.id, ...mcpAnswer(replies[next]) })
          if (!replies[next]) missing = true
          next += 1
        }
      }
    })

    return child
  }

  const fake: McpSpawn = spawn

  return Object.defineProperty(fake, "missing", { get: () => missing }) as McpSpawn & { readonly missing: boolean }
}

function mcpAnswer(reply: GoldenMcpReply | undefined): Record<string, unknown> {
  if (!reply) return { error: { code: "golden:no-reply", message: "the fixture has no reply for this call" } }
  if (reply.error) return { error: reply.error }

  return { result: { content: [{ type: "text", text: reply.text ?? "" }], isError: reply.isError ?? false } }
}

export async function assertGolden<T extends MonitorSource>(fixture: GoldenFixture, definition: SourceDefinition<T>): Promise<void> {
  for (const kase of fixture.cases) {
    const now = clockAt(kase.now ?? fixture.now)
    const scripted = scriptedHttp(kase.replies)
    const calls: GoldenMcpCall[] = []
    const spawn = fakeMcpSpawn(kase.mcpReplies ?? [], calls)
    const mcp = stdioMcp(() => ({ command: "golden", args: [], timeoutMs: 45_000 }), spawn)
    const monitor = defineSource(definition, { http: scripted.http, mcp, now })
    const at = `${fixture.provider} ${kase.name}`

    assert.deepEqual(monitor.build(kase.build), kase.source, `${at}: source`)

    const source = monitor.validateSource(kase.source)
    assert.equal(monitor.key(source), kase.key, `${at}: key`)
    assert.equal(monitor.label(source), kase.label, `${at}: label`)
    assert.equal(monitor.detail(source), kase.detail, `${at}: detail`)
    assert.equal(monitor.describe(source), kase.describe, `${at}: describe`)
    assert.equal(monitor.icon, kase.icon, `${at}: icon`)
    if ("defaultPollIntervalSec" in kase) assert.equal(monitor.defaultPollIntervalSec, kase.defaultPollIntervalSec, `${at}: default poll interval`)
    assert.deepEqual(monitor.input, kase.schema, `${at}: input schema`)

    // A recorded `null` is a first poll, which the runtime gives as an absent cursor.
    const cursor = kase.cursor === null ? undefined : kase.cursor
    const poll = () => definition.poll({ source, cursor, monitorId: "golden", http: scripted.http, mcp, now })

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
      assertCursorShape(definition, kase.cursorAfter, at)
      assert.equal("terminal" in result ? result.terminal : false, kase.terminal ?? false, `${at}: terminal`)
    }

    assert.deepEqual(scripted.requests, kase.requests, `${at}: requests`)
    assert.equal(spawn.missing, false, `${at}: mcp replies ran out`)
    assert.deepEqual(calls, kase.mcpCalls ?? [], `${at}: mcp calls`)
  }

  if (fixture.webhook) assertGoldenWebhook(fixture, fixture.webhook, definition)
}

function assertGoldenWebhook<T extends MonitorSource>(fixture: GoldenFixture, recorded: GoldenWebhook, definition: SourceDefinition<T>): void {
  const at = `${fixture.provider} webhook`
  // Each delivery gets a monitor of its own, as each poll case does, so it sees its own instant.
  const webhookAt = (instant?: string) => defineSource(definition, { http: scriptedHttp([]).http, mcp: stdioMcp(() => undefined), now: clockAt(instant) }).webhook
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
    assertCursorShape(definition, kase.cursorAfter, `${at} ${kase.name}`)
  }
}

/**
 * A recorded cursor must be one the source declares, or a stored cursor would fail its own
 * check after the port. A missing or null cursor is no cursor written, so it has no shape.
 */
function assertCursorShape<T extends MonitorSource>(definition: SourceDefinition<T>, cursorAfter: unknown, at: string): void {
  if (cursorAfter === undefined || cursorAfter === null) return

  assert.ok(v.safeParse(definition.cursor, cursorAfter).success, `${at}: cursor shape`)
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
