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
| `http.ts` | `Http`, `fetchHttp` and the three failures a plugin tells apart. |
| `golden.ts` | `assertGolden`, `scriptedHttp`, `redactHeaders` and the transcript types. |

## What the host owns

Today: the `http` transport, and nothing else. Every poll receives the host's
`Http`; a test or the golden harness supplies its own, and `fetchHttp` is the
only implementation in production. A poll gets no timer, no store and no
secret, so `SourceHost` is the seam the broker replaces once barn owns the
network.

## Not in this slice

- **No grants, budgets or secret-by-name resolution.** The barn B2 broker adds
  them behind `Http`, so a plugin keeps calling `http.json`.
- **No worker, loader, manifest or cancellation signal.** The worker boundary
  brings them, and `SourceContext` grows with it.
- **No webhook, `mergeCursor` or timer owned by the source.** Those are later
  slices; a source that waits returns `{ deferred: true }` and core polls it
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

A provider's fixture is a committed `.ts` transcript recorded from the pre-SDK
tree at `0a1a5e7`, like the other recorded fixtures in the repo: run the old
monitor against the live API, write down each reply in order and each request
it made with `redactHeaders`, and commit the result beside the provider. The
replay serves those replies through `scriptedHttp` and never touches the
network.
