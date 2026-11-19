# SourceFed

SourceFed brings changes from GitHub, Jira, Slack and your feeds into your
agent's session as they happen. The agent opens a pull request, creates a monitor
for it and moves on. When CI fails, a reviewer comments or the branch conflicts,
the event arrives in the session as a message and the agent acts on it. Nobody
pastes a log or reminds the agent to check the PR.

A monitor watches one thing:

- a GitHub pull request, or the issues carrying a set of labels;
- a Jira issue, or the issues matching a JQL query;
- a Slack thread or DM;
- a cron schedule;
- a feed you are signed in to in the [Yab](https://yetanotherbrowser.com)
  browser, such as Gmail's unread inbox.

![The agent creates a monitor for its PR; CI fails on GitHub; sourcefed delivers the failing log and the agent fixes, tests and pushes](docs/media/ci-failure.gif)

![The agent creates a monitor for its PR; a reviewer comments; sourcefed delivers the comment and the agent makes the change and pushes](docs/media/review-comment.gif)

<sub>OpenCode with the sourcefed plugin, on a free model, in a throwaway private
repository. The failing commit and the review comment are staged; GitHub's CI,
the comment and sourcefed's delivery are real. Waiting time is sped up.</sub>

## Install

```sh
brew install stevenjpx2/taps/sourcefed
```

The tap's formula pins 0.5.2. With npm instead, on Node 22.19 or later:

```sh
npm install --global @fdcn/sourcefed@0.5.2
```

Add it to OpenCode, Pi or both:

```sh
sourcefed setup opencode
sourcefed setup pi
```

`sourcefed setup` alone does both. It runs each host's own installer at the
CLI's version. When a host is not on the `PATH`, it prints the manual step
instead. For OpenCode, one entry loads the server and TUI plugins:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["@fdcn/sourcefed@0.5.2"] }
```

For Pi:

```sh
pi install npm:@fdcn/sourcefed@0.5.2
```

## Watch a pull request

The daemon polls every monitor and queues its events. Start it with a GitHub
token in its environment:

```sh
GH_TOKEN=ghp_… sourcefed daemon
```

In a second terminal, watch pull request 42 and print each event as it arrives:

```sh
sourcefed monitor create --source-type github --repo owner/name \
  --pr-number 42 --name pr-42

sourcefed monitor follow
```

The first poll records the reviews and comments already there without sending
them. Each change after that is one event: a review, a comment, a failed
CI job with its log, a merge conflict, or the merge or close, which ends the
monitor.

## Let your agent watch its own work

In OpenCode and Pi, the agent creates its own monitors, and their events come
into its session as messages. After it opens a pull request, it calls
`monitor_create` with:

```json
{
  "name": "PR #42",
  "source": { "type": "github", "repo": "owner/name", "prNumber": 42 }
}
```

The plugin gives the agent these tools:

- OpenCode: `monitor_create`, `monitor_list`, `monitor_status`,
  `monitor_start` and `monitor_stop`.
- Pi: the same tools, named `sourcefed_monitor_create` and so on.

A host starts a local daemon when none is running and connects to it. One daemon
serves every session, and monitors outlive the session that made them. Start the
host with your tokens set; a daemon already running keeps the environment it
started with. Set `SOURCEFED_DAEMON_URL` to use a daemon elsewhere.

`/sourcefed` lists the session's monitors and stops, starts or deletes one. In
OpenCode, ↑ and ↓ select a monitor and show its delivery, poll interval and last
poll; `s` stops or starts it, `d` deletes it after a confirmation, and
`/sourcefed-logs` shows the session's recent notifications.

## Connect an MCP client

Any MCP client can create monitors and read their events. Claude Code takes it
in `.mcp.json`:

```json
{
  "mcpServers": {
    "sourcefed": { "command": "sourcefed", "args": ["mcp", "--stdio"] }
  }
}
```

`sourcefed mcp --http` serves the same tools at `http://127.0.0.1:18788/mcp`
(`--port` or `SOURCEFED_MCP_PORT`) for clients that support remote MCP.

The MCP server runs its own daemon in its process. One daemon owns a state
directory at a time, so give the server its own `SOURCEFED_STATE_DIR` when
another daemon runs.

The tools are `monitor_create`, `monitor_list`, `monitor_status`,
`monitor_start`, `monitor_stop` and `monitor_events_ack`. Each takes a
`target`, `{ "kind": …, "id": … }`, naming whose monitors they are. Events
reach the client through a resource subscription:

1. The client subscribes to its `sourcefed://targets/…/events` resource.
2. The server sends `notifications/resources/updated` when events arrive.
3. The client reads the resource, presents the events and calls
   `monitor_events_ack`.

## Read events from a script

An agent or script without MCP reads events from the CLI, with the daemon
running:

```sh
sourcefed monitor events

sourcefed monitor follow --json

sourcefed monitor ack --event-id EVENT_ID
```

`events` prints what is queued. `follow` prints what is queued, then each new
event as it arrives, and acknowledges what it prints. `follow --json` prints one
event per line and acknowledges nothing, so a script acknowledges each event with
`ack` once it has acted on it. A program can speak the daemon's HTTP protocol
itself: [program targets](docs/program-targets.md) has the protocol and its
delivery guarantees.

## Manage monitors

```sh
sourcefed monitor list
sourcefed monitor status --id MONITOR_ID
sourcefed monitor stop --id MONITOR_ID
sourcefed monitor start --id MONITOR_ID
sourcefed monitor remove --id MONITOR_ID --yes
sourcefed monitor sources
```

Monitors belong to a target. The CLI acts for target kind `cli` and id
`$SOURCEFED_TARGET_ID`, or the hostname, so these commands see only that target's
monitors; `--target-kind` and `--target-id` pick another.
`monitor create --poll-interval-sec` sets a monitor's polling interval, 15
seconds at least.

## Choose a source

```sh
sourcefed monitor create --source-type jira --issue-key PROJ-123 --name PROJ-123

sourcefed monitor create --source-type jira-query \
  --jql "project = PROJ AND labels = agent" --name agent

sourcefed monitor create --source-type github-issues --repo owner/name \
  --labels agent:build --include-existing --name build

sourcefed monitor create --source-type slack \
  --thread-url https://myteam.slack.com/archives/C0123/p1700000000000000

sourcefed monitor create --source-type schedule --cron "0 2 * * *" \
  --timezone Asia/Kolkata --job nightly-audit --name nightly-audit

sourcefed monitor create --source-type yab \
  --url https://mail.google.com/mail/u/0/feed/atom --space Personal \
  --match "interview|offer" --name inbox
```

- **`jira`** sends the issue's new comments and edits, and changes to its status,
  assignee, priority and labels.
- **`github-issues`** follows every open issue carrying all of `--labels`,
  narrowed by `--assignee`, `--author` or search terms in `--query`. It sends
  `item.matched` when an issue starts matching and `item.unmatched` when it
  stops. The first poll is silent unless `--include-existing`. Past 1,000
  matching issues it sends one `error` event and pauses matching.
- **`jira-query`** does the same for the issues matching a bounded JQL query.
- **`slack`** takes `--thread-url`, or `--channel-id` with `--thread-ts`. A DM's
  `D…` `--channel-id` alone watches the DM's new top-level messages. It only
  reads; it never sends.
- **`schedule`** sends `schedule.fired` at each time of `--cron`, in the IANA
  `--timezone` or the Mac's own. Times that pass while the daemon is stopped or
  the Mac sleeps arrive as one `schedule.missed` with their count.
- **`yab`** reads an Atom, RSS or JSON feed through Yab, with the sign-ins of
  its `--space`. `--match` and `--exclude` are case-insensitive regexes over
  each entry's title, summary and author. Yab must be running.

## Configure

Set only the integrations you use, in the environment the daemon starts with.
[`.env.example`](.env.example) lists the integrations' variables.

- **GitHub:** `GH_TOKEN` or `GITHUB_TOKEN`. Without one, GitHub monitors do
  not poll. The monitors on one token share a request budget; see
  [GitHub requests](providers/github/src/api/README.md).
- **Jira:** `SOURCEFED_JIRA_BASE_URL`, `ATLASSIAN_EMAIL` and
  `ATLASSIAN_API_KEY`. `SOURCEFED_JIRA_TERMINAL_STATUS` removes a Jira monitor
  when its issue reaches that status.
- **Slack:** `SOURCEFED_SLACK_TOKEN`, a bot or user token. The bot must be a
  member of each channel or DM it watches. The monitors on one token share a request
  budget; see [Slack polling](providers/slack/src/poll/README.md).
- **Yab:** no token. `SOURCEFED_YAB_COMMAND` names the Yab binary when it is not
  at `/Applications/yab.app/Contents/MacOS/yab`.
- **Webhooks:** `SOURCEFED_GITHUB_WEBHOOK_SECRET` and
  `SOURCEFED_SLACK_SIGNING_SECRET`. With a secret set, monitors take webhooks
  first and poll when the webhook goes quiet. The daemon then also listens for
  webhooks alone on `SOURCEFED_WEBHOOK_HOST`:`SOURCEFED_WEBHOOK_PORT`,
  `127.0.0.1:8788` by default, for a tunnel to point at.
- **Daemon:** `http://127.0.0.1:18787` by default (`--host` and `--port`, or
  `SOURCEFED_DAEMON_HOST` and `SOURCEFED_DAEMON_PORT`). A non-loopback host
  requires `SOURCEFED_DAEMON_TOKEN`, which clients send as a bearer token.
- **State:** `$XDG_STATE_HOME/sourcefed` or `~/.local/state/sourcefed`;
  `SOURCEFED_STATE_DIR` moves it.

## Teach an agent

The CLI serves skills that teach an agent to use sourcefed, always matching the
installed version:

```sh
sourcefed skills
sourcefed skills get core
```

`SOURCEFED_SKILLS_DIR` points at another skills directory.

The name comes from the [SourceFed](https://www.youtube.com/sourcefed) YouTube
channel. MIT licensed; see [LICENSE](LICENSE).

## Roadmap

- [ ] Load source plugins from outside the package
- [ ] The daemon, sources and connections as three rings
      ([RFC #56](https://github.com/wrkhse/sourcefed/issues/56))

## More

- [Program targets](docs/program-targets.md): the daemon's HTTP protocol
- [OpenCode subscription lifecycle](docs/subscription-lifecycle.md)
- [The npm package](packages/sourcefed/README.md): entry points and host
  dependencies
- [0.6.0-rc.3](https://github.com/wrkhse/sourcefed/releases/tag/v0.6.0-rc.3), a
  release candidate published as a GitHub release tarball, with:
  - [the source SDK](packages/sdk/README.md)
  - [the timer source](providers/timer/README.md)
  - [source plugins](docs/source-plugins/)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
