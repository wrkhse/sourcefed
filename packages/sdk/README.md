# Source plugin SDK

A source is a definition plus a poll function. `defineSource` turns it into the
core `Monitor`, so the daemon, the store, the webhook router and
`runtime.tick()` keep running the same object a provider used to subclass.

```ts
import * as v from "valibot"
import { defineSource } from "@sourcefed/sdk"

const FeedSchema = v.object({ type: v.literal("feed"), url: v.string() })

export const feed = defineSource({
  type: "feed",
  schema: FeedSchema,
  input: {
    description: "An Atom feed",
    properties: { url: { type: "string", description: "Feed URL" } },
    required: ["url"],
  },
  build: (input) => (input.url ? { type: "feed", url: input.url } : { error: "url is required for a feed monitor" }),
  key: (source) => `feed:${source.url}`,
  label: (source) => source.url,
  detail: (source) => ` ${source.url}`,
  describe: (source) => `Feed ${source.url}`,
  poll: async ({ source, cursor, http }) => {
    const body = await http.json<{ entries: Array<{ id: string; title: string }> }>(source.url)
    const seen = Array.isArray(cursor) ? cursor.map(String) : []

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

| Module | Responsibility |
| --- | --- |
| `source.ts` | `defineSource` and the `SourceDefinition` / `SourceContext` a provider writes. |
| `http.ts` | `Http`, `httpOver`, `fetchHttp` and the three failures a plugin tells apart. |
| `golden.ts` | `assertGolden`, `scriptedHttp`, `replyResponse`, `redactHeaders` and the transcript types. |

## What the host owns

Today: the `http` transport and the `now` clock, and nothing else. Every poll
receives the host's `Http` and clock; a test or the golden harness supplies its
own, and `fetchHttp` with `new Date()` is the only pair in production.
`http.fetch` answers as the upstream answered (status, headers, body), and
`http.json` reduces a request to its JSON or an `HttpError`. A poll gets no
timer, no store and no secret, so `SourceHost` is the seam the broker replaces
once barn owns the network.

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
- **No webhook delivery, `mergeCursor` or timer owned by the source.** Those
  are later slices. A definition's `wake` only wakes the monitor for an early
  poll, and a source that waits returns `{ deferred: true }` and core polls it
  again.

## Golden transcripts

A fixture is what the pre-SDK tree did, so a port can prove the SDK changes
nothing. Each case holds the create input, the starting cursor, the upstream
replies in order, the redacted requests the plugin made, and the display,
input schema, events and cursor the core `Monitor` returned. `assertGolden`
replays the cases in order and names the provider and case on the first
difference.

```ts
await assertGolden(jiraFixture, jiraDefinition)
```

## Recording a fixture

```sh
node scripts/record-golden.mjs providers/jira/src/fixtures/golden.cases.json 0a1a5e7
```

The recorder creates a temporary detached worktree at the ref and bundles
the old provider from it on its own core. It stubs `fetch` with the cases
file's replies and redacts requests with the same `redactHeaders` the replay
uses. It calls the old poll runner directly to record its returned events,
cursor and terminal flag, or its error. It writes the fixture and its sha256,
then removes the worktree; no live API is contacted.

The cases file names `provider`, the old provider's `entry` and `export`,
the output `fixture` path and API `base`. Its `env` values and `unset`
names configure the provider before import. An optional `now` (an ISO
instant) fixes `new Date()` and `Date.now()` while the old provider runs; the
fixture records it, and the replay gives the source the same clock.

Each entry in `cases` supplies `name`, `build` and ordered `replies`. A
reply has a `body` and an optional `status` (200 when absent) and
`headers`; `replyResponse` turns it into the `Response` both the recorder and
the replay answer with, and a 204 or 304 carries no body. A case without
`continues` is a first poll: it runs with an absent cursor and records
`cursor: null`. A case with `continues: true` starts at the preceding case's
returned cursor, so it cannot follow an error or a deferred case. A poll that
defers records `deferred: true` and no events, cursor or terminal flag.

To check a committed fixture, re-run the recorder at its `recordedFrom`,
then check that its bytes are unchanged:

```sh
git diff --exit-code -- providers/jira/src/fixtures/golden.ts
```
