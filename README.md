# SourceFed

![The agent creates a monitor for its PR; CI fails on GitHub; sourcefed delivers the failing log and the agent fixes, tests and pushes](docs/media/ci-failure.gif)

![The agent creates a monitor for its PR; a reviewer comments; sourcefed delivers the comment and the agent makes the change and pushes](docs/media/review-comment.gif)

<sub>OpenCode with the sourcefed plugin, on a free model, in a throwaway private repository. The failing commit and the review comment are staged; GitHub's CI, the comment and sourcefed's delivery are real. Waiting time is sped up.</sub>

SourceFed delivers new Jira, GitHub, Slack, Yab and timer events into the session.

## Define a source

A source is a definition on `@sourcefed/sdk`; `defineSource` turns it into the
core `Monitor` the daemon already runs.

This is the shape the built-in timer uses:

```ts
import { toMonitorEvent, type MonitorCreateInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { buildTimer } from "./build.ts"
import { timerKey } from "./events.ts"
import { pollTimer } from "./poll.ts"
import { TimerCursorSchema, TimerSourceSchema, type TimerSource } from "./schema.ts"

export const timerSource: SourceDefinition<TimerSource> = {
  type: "timer",
  schema: TimerSourceSchema,
  cursor: TimerCursorSchema,
  input: {
    description: "A timer: fire once at in or at, or each period with every",
    properties: {
      job: { type: "string", minLength: 1, description: "What it is for" },
      in: { type: "string", description: "Fire once after 45m" },
      at: { type: "string", description: "Fire once at a time" },
      every: { type: "string", description: "Fire each 45m" },
    },
    required: ["job"],
  },
  build: (input: MonitorCreateInput, now) => buildTimer(input, now()),
  key: timerKey,
  label: (source) => source.job,
  detail: (source) =>
    ("due" in source ? ` at ${source.due}` : ` every ${source.every}`) +
    ` ${source.timezone}`,
  describe: (source) => `Timer ${source.job}`,
  icon: "󰔛",
  defaultPollIntervalSec: 15,
  poll: async ({ source, cursor, now }) => {
    const result = pollTimer(source, cursor, now())

    return {
      cursor: result.cursor,
      events: result.events.map((e) => toMonitorEvent(e, source)),
      terminal: result.terminal,
    }
  },
}

export const TimerMonitor = defineSource(timerSource)
```

Register it in `SOURCE_MAP` in `packages/daemon/src/registry.ts`.

Jira shows the HTTP seam, with its issue key as input:

```ts
import { toMonitorEvent } from "@sourcefed/core"
import type { MonitorCreateInput, SourceInput } from "@sourcefed/core"
import { defineSource, type SourceDefinition } from "@sourcefed/sdk"
import { JiraCursorSchema, JiraSourceSchema } from "./schema.ts"
import { pollJira } from "./poll/utils"
import type { JiraSourceRecord } from "./types"

export const jiraSource: SourceDefinition<JiraSourceRecord> = {
  type: "jira",
  schema: JiraSourceSchema,
  cursor: JiraCursorSchema,
  input: {
    description: "A Jira issue: comments, edits and status changes",
    properties: {
      issueKey: { type: "string", description: "Jira issue key, e.g. PROJ-12345" },
    },
    required: ["issueKey"],
  },
  build: (input: MonitorCreateInput): SourceInput => {
    if (input.issueKey) return { type: "jira", issueKey: input.issueKey }
    return { error: "issueKey is required for a jira monitor" }
  },
  key: (source) => `jira:${source.issueKey}`,
  label: (source) => source.issueKey,
  detail: (source) => ` ${source.issueKey}`,
  describe: (source) => `Jira ${source.issueKey}`,
  icon: "󰌃",
  poll: async ({ source, cursor, http }) => {
    const result = await pollJira(http, source.issueKey, cursor)

    return {
      cursor: result.cursor,
      events: result.events.map((e) => toMonitorEvent(e, source)),
      terminal: result.terminal,
    }
  },
}

export const JiraMonitor = defineSource(jiraSource)
```

A source never handles tokens itself; it names the header through the host's `http`:

```ts
const issue = await http.json(url, {
  headers: { Authorization: jiraAuth(), Accept: "application/json" },
})
```

```sh
sourcefed monitor create --name deploy --source-type timer \
  --job "check the deploy" --in 20m
sourcefed monitor create --source-type jira --issueKey PROJ-123 --name PROJ-123
```

## Source plugins

`defineSource`, a source's schemas and its input are set out in the
[P0 SDK page][p0-sdk] and the [SDK README][sdk-readme]. `build(input, now)`
gets the host's clock, shown in the [P1b timer page][p1b-timer].
`poll({ source, cursor, http, mcp, now, monitorId })` returns
`{ events, cursor, terminal }` or `{ deferred: true }`, and the host owns the
clock, HTTP and MCP ([P0 SDK page][p0-sdk]). A terminal event is delivered
before its record goes ([P1b timer page][p1b-timer]).

## Install

```sh
brew install stevenjpx2/taps/sourcefed
```

(`npm install --global @fdcn/sourcefed` installs the same CLI.)

The package ships one artifact with everything:

```text
sourcefed                 CLI (daemon, MCP, monitor management, skills)
@fdcn/sourcefed/core      monitor engine: domain model, poll/webhook transports,
                          cursors, event queues, JSON store
@fdcn/sourcefed/daemon    transport-neutral application service: monitor commands,
                          event reads/acknowledgement, subscriptions, JSON protocol
@fdcn/sourcefed/mcp       the daemon through MCP tools and resource subscriptions
@fdcn/sourcefed/server    OpenCode server plugin (tool registration, guidance)
@fdcn/sourcefed/tui       OpenCode TUI plugin (sidebar, /sourcefed dialogs)
@fdcn/sourcefed/pi        Pi extension
```

Jira, GitHub, Slack, and Yab providers are built in; the daemon composes the provider registry
directly. The daemon owns polling, webhook handling, cursors, monitor identity, retries,
and the shared state store. Hosts provide a target identity and an event bridge.

## OpenCode And Pi

Install the plugins in one step:

```sh
sourcefed setup                 # both hosts
sourcefed setup opencode        # or one at a time
sourcefed setup pi
```

`setup` delegates to each host's own installer: `opencode plugin add @fdcn/sourcefed@<version>`, then `pi install npm:@fdcn/sourcefed@<version>`. When a host binary is missing, it prints the manual instructions below.

Manually, OpenCode takes one entry, and the CLI picks up the TUI plugin from it:

```json
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["@fdcn/sourcefed@0.5.2"] }
```

Pi:

```sh
pi install npm:@fdcn/sourcefed@0.5.2
```

Pi supplies its extension SDK, TUI widgets and TypeBox. These are optional peers
of Sourcefed; OpenCode-only and CLI installs download no Pi host packages. See
[host dependencies](packages/sourcefed/README.md#host-dependencies) for the package
contract and verification command.

OpenCode resolves the server entrypoint from `exports["./server"]` and the TUI
plugin from `exports["./tui"]`; Pi loads the extension
from the package's `pi` metadata. Both register `monitor_create`/`monitor_list`/
`monitor_status`/`monitor_start`/`monitor_stop` tools, and `/sourcefed` plus
`/sourcefed-logs` dialogs. `/sourcefed` lists the session's monitors with the selected
one's detail (delivery, poll interval, created/updated timestamps, last poll, webhook
heartbeat); ↑/↓ selects, `s` stops or starts it, and `d` deletes it after a confirmation.

Without `SOURCEFED_DAEMON_URL`, a host spawns one local HTTP daemon when none is running
and connects to it, so monitors persist across sessions and share one registry.

## Daemon

```sh
sourcefed daemon
```

The HTTP daemon serves `POST /rpc`, `GET /events?target=...` (SSE push), and provider
webhooks at `/webhooks/github` and `/webhooks/slack`. It defaults to
`http://127.0.0.1:18787` (`SOURCEFED_DAEMON_HOST`/`SOURCEFED_DAEMON_PORT`, or `--host`/
`--port`); clients use `SOURCEFED_DAEMON_URL` or `SOURCEFED_DAEMON_PORT`. Binding to a
non-loopback address requires `SOURCEFED_DAEMON_TOKEN`, which clients send as a bearer
token on `/rpc` and `/events`.

When any webhook secret is configured (or `SOURCEFED_ENABLE_WEBHOOKS=1`), the daemon also
starts a webhook-only listener on `SOURCEFED_WEBHOOK_HOST`:`SOURCEFED_WEBHOOK_PORT`
(default `127.0.0.1:8788`). Point a tunnel or reverse proxy at it (e.g. bind `0.0.0.0`) to
receive GitHub/Slack webhooks publicly while RPC and events stay on loopback; webhook
signature (HMAC / Slack signing) authenticates requests, not the daemon token.

In OpenCode, a plugin can gate delivery: sourcefed asks it about each event, with the
event's `monitorID`, and skips events it judges need no action (bot comments, approvals,
status churn). With no gate, or if the gate fails or takes over 3 s, every event is
delivered. Events delivered to OpenCode carry `metadata.sourcefed` (`eventID`, `monitorID`,
`kind`), so plugins can tell them from the user's own messages.

OpenCode plugin instances share one process-wide subscription hub: at most one SSE
stream per enabled, owned session target, regardless of how many project locations
are loaded. Stopped monitors, deleted sessions and unloaded owners release streams;
external CLI/Chauffeur changes are reconciled every 15 seconds. Long-lived SSE uses
dedicated HTTP/HTTPS sockets rather than `fetch`, so valid monitoring demand cannot
occupy Bun’s process-wide fetch slots needed by providers and other plugins. See
[subscription lifecycle](docs/subscription-lifecycle.md) for ownership and cleanup rules.

### Chauffeur triage

When a Chauffeur v2 daemon runs, every event is triaged at the daemon's sink before it is
queued, so OpenCode, Pi, MCP and the CLI see the same filtered stream. Only an explicit
`withhold: "event"` intent drops an event; a missing daemon, a v1 daemon, an error or a
3-second deadline lets it through, so delivery never depends on Chauffeur. The daemon
looks on `$XDG_RUNTIME_DIR/chauffeur/daemon.sock`, then `chauffeur-next/daemon.sock`
(the temporary folder when `XDG_RUNTIME_DIR` is unset); set `CHAUFFEUR_SOCKET` to point
it at one socket. See [Chauffeur v2 triage](packages/daemon/src/triage/README.md).

The triage rule itself is installed with:

```sh
sourcefed setup chauffeur                  # for chauffeur-next
sourcefed setup chauffeur --name chauffeur # only when a v2 daemon answers there
```

It writes `sourcefed/triage` to `$XDG_CONFIG_HOME/chauffeur-next/rules/sourcefed/triage.json`
(`~/.config` when unset), which Chauffeur v2 loads on its next rule reload. The install is
v2 only: `--name chauffeur` is refused unless a Chauffeur v2 daemon answers on that name's
socket, because v1 reads the same folder. chauffeur-next is the default until Chauffeur's
cutover, and an existing rule file is never overwritten.

## MCP

```sh
sourcefed mcp --http      # MCP at http://127.0.0.1:18788/mcp (SOURCEFED_MCP_PORT)
sourcefed mcp --stdio
```

New events use the current MCP 2026 resource-subscription flow:

1. A host subscribes with `subscriptions/listen` to its `sourcefed://targets/.../events` resource.
2. The daemon publishes `notifications/resources/updated`.
3. The host reads the resource, presents the events, and calls `monitor_events_ack`.

### Adding it to an agent

Point your agent's MCP client at the server with stdio or HTTP. The server owns an
in-process daemon, so `monitor create` through MCP behaves exactly like the CLI.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "sourcefed": { "command": "sourcefed", "args": ["mcp", "--stdio"] }
  }
}
```

opencode (`opencode.json`):

```json
{
  "mcp": {
    "sourcefed": { "type": "local", "command": ["sourcefed", "mcp", "--stdio"], "enabled": true }
  }
}
```

A shared HTTP server works for any client that supports remote MCP: start
`sourcefed mcp --http` once, then point clients at `http://127.0.0.1:18788/mcp`.

## CLI

```sh
sourcefed monitor create --source-type jira --issue-key ADEPT-43742 --name ADEPT-43742
sourcefed monitor create --source-type jira-query --jql "project = PROJ AND labels = agent" --name agent
sourcefed monitor create --source-type github --repo owner/name --pr-number 42 --name pr-42
sourcefed monitor create --source-type github-issues --repo owner/name --labels agent:build --include-existing --name build
sourcefed monitor create --source-type slack --thread-url https://myteam.slack.com/archives/C0123/p1700000000000000
sourcefed monitor create --source-type slack --channel-id D0123456789 --name "DM with Alex"
sourcefed monitor create --source-type schedule --cron "0 2 * * *" --timezone Asia/Kolkata --job nightly-audit --name nightly-audit
sourcefed monitor create --name deploy --source-type timer --job "check the deploy" --in 20m
sourcefed monitor create --source-type yab --url https://mail.google.com/mail/u/0/feed/atom --space Personal --match "interview|offer" --name inbox
sourcefed monitor list
sourcefed monitor status --id MONITOR_ID
sourcefed monitor events
sourcefed monitor follow       # live tail of new events (SSE); Ctrl+C to stop
sourcefed monitor ack --event-id EVENT_ID
sourcefed monitor stop --id MONITOR_ID
sourcefed monitor start --id MONITOR_ID
sourcefed monitor remove --id MONITOR_ID --yes
sourcefed monitor sources
```

Monitors belong to a target; the CLI defaults to `--target-kind cli` and `--target-id`
`$SOURCEFED_TARGET_ID` (falling back to the hostname), so list/status/stop only see
monitors created for that target. Slack accepts `--thread-url`, `--channel-id` +
`--thread-ts`, or a `D…` DM `--channel-id` by itself to watch new top-level DM
messages; `--poll-interval-sec` (min 15) tunes polling. `github-issues` follows every open
issue carrying all of `--labels` (comma-separated), optionally narrowed by `--assignee`,
`--author` or extra search terms in `--query`. It sends `item.matched` when an issue starts
matching and `item.unmatched` when it stops; the first poll is silent unless
`--include-existing`. Past 1,000 matching issues it sends one `error` event and pauses
matching. `jira-query` does the same for the issues matching `--jql`, a bounded JQL query
(Jira refuses one with no restriction). `schedule` takes `--cron`, a `--job` name and an
optional IANA `--timezone` (the Mac's own when left out). It sends `schedule.fired` at each
time, checking every 15 seconds by default, and one `schedule.missed` with the latest time and
a `missed` count for the times that came while the daemon was stopped or the Mac slept. `timer` takes a `--job` and one of `--in` (a duration such as
`20m`), `--at` (a time such as `2026-11-19T15:00`, in `--timezone` or with an offset) or
`--every` (a period such as `45m`). A one-shot sends one `timer.fired`, marked late when
found more than two minutes after it was due, and then removes itself; an interval sends
`timer.fired` each period and one `timer.missed` for periods that came while the daemon was
stopped. A crash in the instant between saving an event and saving the monitor can, rarely,
repeat a firing once. Yab takes `--url` (an Atom, RSS or
JSON feed), an optional `--space`, and `--match`/`--exclude` case-insensitive regexes over
each entry's title, summary and author. Set `SOURCEFED_DAEMON_URL`
when the daemon is not at the default URL.

### Getting events without MCP

Agents that don't integrate MCP can read events straight from the CLI:

```sh
# snapshot of queued events
sourcefed monitor events

# live tail — blocks and prints each new event as it arrives
sourcefed monitor follow

# acknowledge what you consumed so the next read starts clean
sourcefed monitor ack --event-id EVENT_ID
```

`follow` drains the queued events first, then prints live ones over SSE. Pipe its
stdout into a loop, a file, or the agent's own reader. `follow --json` prints one queued
event per line and acknowledges nothing, for a script that acknowledges each event once it
has acted on it. A program connects to the daemon's HTTP API instead, starting with
`daemon.health`; [program targets](docs/program-targets.md) has the protocol and the contract.

### Skills

The CLI bundles skills that teach agents how to use sourcefed, served in the agent-browser
style: a thin discovery stub plus CLI-served content that always matches the installed version.

```sh
sourcefed skills            # list available skills
sourcefed skills get core   # load the core usage guide
sourcefed skills get core --full
sourcefed skills path core
```

Set `SOURCEFED_SKILLS_DIR` to override the bundled skills directory.

## Configuration

Copy `.env.example` to a secure environment configuration and set only the integrations you
use:

- **Jira** — requires `SOURCEFED_JIRA_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_KEY`.
- **GitHub / Slack webhooks** — optional `SOURCEFED_GITHUB_WEBHOOK_SECRET` /
  `SOURCEFED_SLACK_SIGNING_SECRET`. With them, monitors prefer webhook delivery and fall
  back to polling when the webhook goes quiet; without them they poll.
- **GitHub polling** — `GH_TOKEN` or `GITHUB_TOKEN` (without one, GitHub monitors do not
  poll). Calls the REST and GraphQL APIs directly. With the webhook secret set, GitHub's
  `issues` webhooks wake `github-issues` monitors of that repository early.
  All GitHub monitors on one token share a budget of 30 REST and 30 GraphQL requests a
  minute (`SOURCEFED_GITHUB_REQUESTS_PER_MINUTE`, at most 75, read when the daemon
  starts), about a third of GitHub's 5000 an hour, leaving the rest for other use of the
  account. A pull request poll sends one GraphQL query and two or more REST requests, so
  at the default each pull request monitor polls about every
  `max(pollIntervalSec, monitors × 4s)`; an issues poll sends one. When GitHub
  rate-limits a call, every monitor on that token using that API waits until GitHub's
  `Retry-After` or quota reset (at most an hour) and the log gets one line. Other failed
  answers, such as a 404, show as poll failures with their status.
- **Slack polling** — `SOURCEFED_SLACK_TOKEN` (bot or user token). Reads and notifies only;
  never sends messages. The bot must be a member of the channel or DM it monitors.
  All Slack monitors on one token share a budget of 20 requests a minute
  (`SOURCEFED_SLACK_REQUESTS_PER_MINUTE`, at most 45, read when the daemon starts), so
  more monitors poll less often instead of sending more: each polls about every
  `max(pollIntervalSec, monitors × 3s)` at the default, about 100s with 32 monitors and
  200s with 64. When Slack rate-limits a call, every monitor on that token waits out its
  `Retry-After` (at most an hour) and the log gets one line. Apps distributed outside the
  Slack Marketplace get 1 request a minute; set the variable to `1` for them. Slack counts
  requests per app per workspace, so anything else using the same app shares its limit.
- **Yab feeds** — reads the feed through the [Yab](https://yetanotherbrowser.com) browser's
  `fetch` tool (`yab mcp`, started per poll), so it uses the browser's sign-ins: private
  feeds such as Gmail's unread-inbox Atom feed work with no token. Yab must be running;
  `SOURCEFED_YAB_COMMAND` overrides the binary path.
- **Poll failures** — a failed poll logs one line with the monitor's id, its source's label and
  the error's message, with newlines collapsed and long text cut. A source marks a failure it
  expects with `PollSourceError`; anything else it throws is a bug and keeps its stack, as does
  any failure with `SOURCEFED_DEBUG=1`. Yab's own error text is quoted only with
  `SOURCEFED_DEBUG=1`, and then reduced to the feed's host.

State:

- The JSON store defaults to `$XDG_STATE_HOME/sourcefed` or `~/.local/state/sourcefed`;
  override with `SOURCEFED_STATE_DIR`.
- One daemon owns a state dir at a time (a lock file guards it); adapters reuse an
  already-running daemon instead of spawning another.
- A new monitor's first successful poll primes history: existing comments, reviews, and
  messages are recorded silently; only activity after that point is delivered as events.

## Development

```sh
npm install
npm run check
```

`npm run check` builds the workspace bundles and the public package, builds the test
bundles, runs the suite under `node --test`, and typechecks.

### Sources

Every source is a definition on `@sourcefed/sdk`, proven against a transcript
recorded from the code before the SDK. To re-record one, run the recorder at the
commit the fixture records, then check that the fixture's bytes are unchanged:

```sh
node scripts/record-golden.mjs providers/jira/src/fixtures/golden.cases.json 0a1a5e7
git diff --exit-code -- providers/jira/src/fixtures/golden.ts
```

See [source plugins](docs/source-plugins/).

![OpenCode with sourcefed 0.6.0-rc.1: a real GitHub issue match and a real
minute-schedule event are delivered, the model checks each monitor's status
and stops it, and the daemon log shows the matching
deliveries](docs/media/p0-sdk.gif)

<sub>The 0.6.0-rc.1 candidate in OpenCode, on a free model. The GitHub read
(`includeExisting` on a public issue) and the clock are real, and so is the
model's reaction with the monitor tools; the wait between the events is cut. It
shows two of the seven sources; the golden replays cover all seven.</sub>

The [timer source](docs/source-plugins/p1b-timer.md) in
[0.6.0-rc.2](https://github.com/wrkhse/sourcefed/releases/tag/v0.6.0-rc.2)
adds one-shot and interval monitors, including one that fires across a daemon
restart.

![OpenCode with the rc.2 timers: one-shot, interval and a restart across a due
time](docs/media/p1b-timers.gif)

<sub>OpenCode with the rc.2 candidate on a free model. Three real timer events
are delivered, one across a daemon restart; the waits between firings are
cut.</sub>

### Integration Tests

`npm run integration` packs every workspace package, installs the tarballs into an isolated
consumer project, and runs real-life scenarios against the installed artifacts:

- **core / daemon / cli / mcp** — store/queue/lock behavior, daemon lifecycle with event
  delivery, the installed binary driving a live daemon, and the 2026 resource-subscription
  flow against a real MCP HTTP server
- **provider-\*** — each provider polling against mocked upstreams through a live daemon tick
- **public-package** — the aggregate tarball alone: subpath imports, the npm-created bin,
  daemon + RPC, no TypeScript in `dist`
- **opencode / pi adapters** — the installed aggregate plugin in a private OpenCode
  server invokes its registered monitor tool through a deterministic test command,
  without model credentials; Pi RPC mode loads the extension directly. Both use
  owned test daemons. Both hosts are required: a scenario fails when its host is missing.

Pass scenario file names to run only those, for example
`npm run integration -- pi.test.mjs pi-package.test.mjs`; a filtered run prints how many
of the scenarios it selected.

Releases follow [docs/e2e-release-plan.md](./docs/e2e-release-plan.md): the exact tarball
that publishes is tested with no private workspace packages installed, every scenario must
pass with zero skips, and registry canaries gate config and tap updates.

Monitor state is intentionally ignored by Git. Never commit Jira keys, repository names,
Slack URLs, session IDs, webhook payloads, or credentials in tests and examples.

## License

MIT. See [LICENSE](./LICENSE).

[p0-sdk]: docs/source-plugins/p0-sdk.md
[sdk-readme]: packages/sdk/README.md
[p1b-timer]: docs/source-plugins/p1b-timer.md
