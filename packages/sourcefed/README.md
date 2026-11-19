# @wrkhse/sourcefed

SourceFed brings changes from GitHub, Jira, Slack and feeds into an agent's
session as they happen. This package holds the `sourcefed` CLI and daemon, the
MCP server and the OpenCode and Pi plugins. The
[repository README](https://github.com/wrkhse/sourcefed#readme) walks through
watching a pull request, host setup, MCP and every source.

## Install the CLI

```sh
npm install --global @wrkhse/sourcefed@0.6.0-rc.3
```

> This is a release candidate. The stable pin moves to
> `@wrkhse/sourcefed` when 0.6.0 ships.

```text
sourcefed daemon [--port PORT] [--host HOST]
sourcefed mcp --stdio|--http [--port PORT]
sourcefed monitor create|list|status|stop|start|remove|events|follow|ack|logs|sources
sourcefed skills [list|get <name>|path [name]]
sourcefed setup [opencode|pi]
```

`monitor` commands talk to a running `sourcefed daemon`.

## Use it as a library

A program reads its monitors through the daemon client:

```ts
import { connectDaemonClient } from "@wrkhse/sourcefed/daemon"

const client = await connectDaemonClient({ name: "my-script" })

const result = await client.request("monitor.list", {
  target: { kind: "program", id: "my-script" },
})
// result: { ok: true, monitors: [ … ] }

await client.close()
```

- `@wrkhse/sourcefed`: the CLI, also the `sourcefed` binary.
- `@wrkhse/sourcefed/core`: monitors, sources, events and cursors, such as
  `MonitorService`.
- `@wrkhse/sourcefed/core/storage`: the JSON store and event queue.
- `@wrkhse/sourcefed/daemon`: the daemon service and its HTTP and SSE client.
- `@wrkhse/sourcefed/mcp`: the MCP server, `createSourcefedMcp` and
  `createSourcefedStdio`.

The daemon's protocol and delivery guarantees are in
[program targets](https://github.com/wrkhse/sourcefed/blob/main/docs/program-targets.md).

### Reply to an issue

The daemon client offers `comment.issue` beside the monitor methods
(`monitor.list`, `monitor.create`, `monitor.ack`). It posts a reply through the
daemon, which sends the GitHub POST with its own `GH_TOKEN` or `GITHUB_TOKEN`,
so the caller never handles a token:

```ts
const sf = await connectDaemonClient({ name: "my-script" })

const reply = await sf.comment.issue({
  repo: "owner/name",
  issueNumber: 56,
  body: "Fixed on the branch; thanks for the report.",
})
// reply: { id: 12345, url: "https://github.com/owner/name/issues/56#issuecomment-12345" }

await sf.close()
```

`body` must be non-empty and at most 65,536 characters.

## Load it in a host

OpenCode loads the server and TUI plugins from one entry:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["@wrkhse/sourcefed@0.6.0-rc.3"] }
```

Pi loads the extension named in the package's `pi` metadata:

```sh
pi install npm:@wrkhse/sourcefed@0.6.0-rc.3
```

A host that loads entry points directly finds them here:

- `./server` and `./opencode`: the OpenCode server plugin.
- `./tui` and `./opencode/tui`: the OpenCode TUI plugin.
- `./pi`: the Pi extension.

## Host dependencies

Pi provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and
`typebox` through its extension loader. This package declares each as an
optional peer with a `"*"` range and leaves their imports external in
`dist/pi.js`, following
[Pi's package contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies).
The CLI, daemon, MCP and OpenCode entry points do not import them, so a plain
npm install downloads no Pi packages, and a Pi host supplies its own versions.
The packed package is checked for this by
[`scripts/check-optional-pi.mjs`](https://github.com/wrkhse/sourcefed/blob/main/scripts/check-optional-pi.mjs).