# Source plugin SDK

The slice as a whole, its parts and its checks are in
[P0: the SDK](../../docs/source-plugins/p0-sdk.md).

A source is a definition plus a poll function. `defineSource` turns it into the
core `Monitor`, and the daemon, the store, the webhook router and
`runtime.tick()` run the `Monitor` it returns, unchanged.

```ts
import * as v from "valibot"
import { defineSource } from "@sourcefed/sdk"

const FeedSchema = v.object({ type: v.literal("feed"), url: v.string() })
const SeenSchema = v.array(v.string())

export const feed = defineSource({
  type: "feed",
  schema: FeedSchema,
  cursor: SeenSchema,
  input: {
    description: "An Atom feed",
    properties: { url: { type: "string", description: "Feed URL" } },
    required: ["url"],
  },
  build: (input) =>
    input.url
      ? { type: "feed", url: input.url }
      : { error: "url is required for a feed monitor" },
  key: (source) => `feed:${source.url}`,
  label: (source) => source.url,
  detail: (source) => ` ${source.url}`,
  describe: (source) => `Feed ${source.url}`,
  poll: async ({ source, cursor, http }) => {
    const body = await http.json<{ entries: Array<{ id: string; title: string }> }>(
      source.url,
    )
    const stored = v.safeParse(SeenSchema, cursor)
    const seen = stored.success ? stored.output : []

    return {
      events: body.entries
        .filter((entry) => !seen.includes(entry.id))
        .map((entry) => ({
          source,
          kind: "entry",
          id: entry.id,
          at: new Date().toISOString(),
          summary: entry.title,
          actionable: true,
        })),
      cursor: body.entries.map((entry) => entry.id),
      terminal: false,
    }
  },
})
```

- `source.ts`: `defineSource` and the `SourceDefinition` / `SourceContext` /
  `SourceWebhook` a provider writes.
- `http.ts`: `Http`, `httpOver`, `fetchHttp` and the three failures a plugin
  tells apart.
- `mcp.ts`: `Mcp`, `stdioMcp`, `hostMcpServers` and `McpError`: the MCP
  servers the host runs for a source.
- `golden.ts`: `assertGolden`, `fakeMcpSpawn`, `webhookSteps`,
  `withEnvironment`, `scriptedHttp`, `goldenRequest`, `replyResponse`,
  `redactHeaders` and the transcript types.

A definition's `cursor` is the shape of the cursor the source stores under
its key: a valibot schema, the one its poll already parses the stored cursor
with. `assertGolden` checks every recorded cursor against it, so a port cannot
write a cursor its own source would refuse. A later change of shape is a
migration the source declares.

A definition's `build` is `(input: MonitorCreateInput, now: () => Date) =>
SourceInput`: the clock is the host's, the same one `poll` and a webhook's
`verify` and `parse` receive, so a source that resolves relative input, such as
a timer's `in`, reads it there. The host binds the clock, so core's
`Monitor.build` keeps one argument.

A definition's optional `defaultPollIntervalSec` is how often a new monitor
of the source polls when the caller names no interval, such as `900` for a
source whose upstream changes slowly.

## Webhooks and merged cursors

A definition's `webhook` delivers events itself, beside the poll. It takes the
same options as core's `WebhookMonitor` (`path`, `configured`, `deliveryId`,
`eventName`, `challenge`, `updateCursor`, …), and `defineSource` builds one
from it, so the daemon routes, retries and heartbeats it as it does core's.
`verify` and `parse` also receive the host's clock: a signature's age and an
event's fallback time are judged by the host, so a recorded delivery replays at
its recorded instant.

```ts
webhook: {
  path: "/webhooks/feed",
  configured: () => Boolean(process.env.FEED_WEBHOOK_SECRET),
  verify: (body, request, now) => validSignature(body, request, now()),
  deliveryId: (request) => request.headers.get("x-feed-delivery") ?? undefined,
  eventName: (request) => request.headers.get("x-feed-event") ?? "feed",
  parse: (payload, eventName, deliveryId, now) =>
    toEvent(payload, eventName, deliveryId, now()),
  updateCursor: (event, cursor) => [
    ...(Array.isArray(cursor) ? cursor : []),
    event.id,
  ],
},
mergeCursor: mergeCursors,
```

A source whose webhook writes the cursor also gives `mergeCursor`: how a
poll's cursor is merged into the stored one, so a poll does not replace what a
delivery wrote while it ran. Without it, a poll's cursor replaces the stored
one.

## What the host owns

The host owns the `http` transport, the `mcp` servers and the `now` clock,
and nothing else. Every poll and every webhook's `verify` and `parse` receive the
host's clock, and every poll the host's `Http` and `Mcp`; a test or the
golden harness supplies its own, and `fetchHttp`, `stdioMcp(hostMcpServers)`
and `new Date()` are the only ones in production.
`http.fetch` answers as the upstream answered (status, headers, body), and
`http.json` reduces a request to its JSON or an `HttpError`. A poll gets no
timer, no store and no secret, so `SourceHost` is the seam the broker replaces
once barn owns the network.

## MCP servers

A source never starts a process: it names a server the host runs and calls one
of its tools, and gets the tool's text parts joined by newlines.

```ts
const page = await mcp.call("yab", "fetch", { url: source.url, html: true })
```

Yab is the host's only server. `hostMcpServers` runs it from
`SOURCEFED_YAB_COMMAND`, read at each call, or the app's own binary, with a
45 s limit per call. `stdioMcp` speaks MCP over stdio and starts one process
per call, stopped once the call settles, so nothing stays connected between
polls.

Each call is bounded. Past 16 MiB of output without a finished answer it fails
with `overflow`, and `McpError.limitBytes` says how much it allowed. Stderr
keeps its first 4096 characters, well more than the few hundred a source
quotes: a source redacts before it quotes, and text cut first could end inside
a URL, leaving a credential that no longer looks like one. Once the outcome is
decided the child gets SIGTERM, SIGKILL two seconds later, and the call answers
two seconds after that whatever happens, so no call outlives `timeoutMs` plus
four seconds and no timer outlives the call.

A server the host does not run rejects with a plain `Error`: that is a
configuration bug, not a failed call.

A call that produces no text rejects with an `McpError` whose `failure` is
`start`, `timeout`, `exit` (with `exitCode`), `error` (a JSON-RPC error,
with its `code`), `tool` (the tool reported a failure) or `overflow` (with
`limitBytes`). The server's own
words, its stderr or the tool's failure text, are in `detail` and never in
`message`: they may quote what the source sent, such as a feed URL whose path
is its credential, so the source decides whether and how to show them.

## What crosses the boundary

The poll's `source`, `cursor` and `monitorId`, and its result
(`{ events, cursor, terminal }` or `{ deferred: true }`), are plain JSON.
That lets the same poll run behind a worker or engine boundary later without
changing a source. `http` is a seam the host supplies, not data, so a source
never holds a network handle of its own.

## Not in this slice

- **No grants, budgets or secret-by-name resolution.** The barn B2 broker adds
  them behind `Http`, so a plugin keeps calling `http.json`.
- **No worker, loader, manifest or cancellation signal.** The worker boundary
  brings them, and `SourceContext` grows with it.
- **No timer owned by the source.** A definition's `wake` only wakes the
  monitor for an early poll, and a source that waits returns
  `{ deferred: true }` and core polls it again.

## Golden transcripts

A fixture is what the pre-SDK tree did, so a port can prove the SDK changes
nothing. Each case holds the create input, the starting cursor, the upstream
replies in order, the redacted requests the plugin made, and the display,
input schema, events and cursor the core `Monitor` returned. `assertGolden`
replays the cases in order and names the provider and case on the first
difference. A request records its `body` only when it sent a string, such as
a GraphQL POST, so a GET's record has no `body` key.

A fixture may also carry the source's `webhook`: its `path`, `preferred`,
`acknowledgeBeforeDelivery` and `configured()`, and its recorded deliveries.
Each delivery holds the request's headers and exact body, the stored cursor it
met, and what each step of core's `handleWebhook` made of it, stopping where
`handleWebhook` stops: `verified`, then `challenge`, `deliveryId`,
`eventName`, the parsed `event` and the `cursorAfter` that `updateCursor`
would write. `webhookSteps` runs those steps for both the recorder and the
replay, so the two cannot drift; `assertGolden` names the provider and the
delivery on a difference (`github webhook review`).

A case may also carry `mcpReplies`, the answers the recorded server gave in
order, and `mcpCalls`, the tool calls the source made (`{ tool, arguments }`).
The replay runs the real `stdioMcp` client against `fakeMcpSpawn`, a server
that answers over in-memory streams with no process, and asserts the calls
equal the recorded ones. A source that calls more tools than the case has
replies fails loudly with code `golden:no-reply`. A case without them records
no calls, so a source that never calls MCP replays unchanged. A case records
`defaultPollIntervalSec` when the old monitor defines one, and the replay
holds the source to it.

A golden test sets the provider's environment with `withEnvironment`, which
sets each variable (`undefined` removes one) for the run and puts every one
back afterwards, even when the run throws, so it does not leak into the tests
that run after it.

```ts
test("the jira source replays its recorded transcript", async () => {
  const env = {
    ATLASSIAN_API_KEY: "test-key",
    SOURCEFED_JIRA_TERMINAL_STATUS: undefined,
  }

  await withEnvironment(env, async () => {
    await assertGolden(jiraFixture, jiraDefinition)
  })
})
```

## The monitors.json audit

`packages/daemon/src/monitors-audit.test.ts` checks that a stored
`monitors.json` survives the port. It builds a record from each fixture's last
cursor under its recorded key, saves the records through `JsonMonitorStore` in
a temporary folder and loads them back with a fresh store. Each record must
keep the SDK source's key, hold its cursor under that key and parse with the
source's `cursor` schema, and every source type must be covered. The live
state is never read.

## Recording a fixture

```sh
node scripts/record-golden.mjs providers/jira/src/fixtures/golden.cases.json 0a1a5e7
```

The recorder creates a temporary detached worktree at the ref and bundles
the old provider from it on its own core. It stubs `fetch` with the cases
file's replies and records requests with the same `goldenRequest` the replay
uses. It calls the old poll runner directly to record its returned events,
cursor and terminal flag, or its error. It writes the fixture and its sha256,
then removes the worktree; no live API is contacted and no process is started
beyond `git` and esbuild's service. The pre-SDK Yab provider starts `yab mcp`
itself, so for the whole run node's `spawn` is replaced in-process: a case
with `mcpReplies` is answered by `fakeMcpSpawn` in memory, and in any other
case starting a process throws, so the attempt is recorded as the case's
error instead of running.

The cases file names `provider`, the old provider's `entry` and `export`,
the output `fixture` path and API `base`. Its `env` values and `unset`
names configure the provider before import. An optional `now` (an ISO
instant) fixes `new Date()` and `Date.now()` while the old provider runs; the
fixture records it, and the replay gives the source the same clock.

A poll case or a webhook delivery may carry its own `now`, which overrides the
file's for that case alone; one with neither runs on the real clock. Give
cases their own instants when the provider reads the clock between them: a
rate limiter whose budget refills over time, so a chain of polls runs minutes
apart as a real monitor's do, or a signature check that judges a delivery's
age. The fixture records `now` right after the case's `name`, and only on a
case that was given one.

Each entry in `cases` supplies `name`, `build` and ordered `replies`. A
reply has a `body` and an optional `status` (200 when absent) and
`headers`; `replyResponse` turns it into the `Response` both the recorder and
the replay answer with, and a 204 or 304 carries no body. A case without
`continues` is a first poll: it runs with an absent cursor and records
`cursor: null`. A case with `continues: true` starts at the preceding case's
returned cursor, so it cannot follow an error or a deferred case. A poll that
defers records `deferred: true` and no events, cursor or terminal flag. A
case may give `mcpReplies`, each `{ text }`, `{ text, isError: true }` or
`{ error: { code, message } }`; the fixture records them and the calls made
right after `requests`, and the recorder fails naming the case when they run
out.

An optional `webhooks` list records deliveries to the old monitor's
`webhook` after the poll cases, with the fixed clock in place. Each entry has
`name`, `headers`, `body` and an optional starting `cursor` (`null` when
absent). `body` is the exact string sent, so a signature in `headers`
computed over it stays valid. A cases file without `webhooks` records no
`webhook`, so its fixture keeps its bytes.

To check a committed fixture, re-run the recorder at its `recordedFrom`,
then check that its bytes are unchanged:

```sh
git diff --exit-code -- providers/jira/src/fixtures/golden.ts
```
