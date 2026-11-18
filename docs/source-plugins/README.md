# Source plugins

A source plugin is a new kind of source, written as a small TypeScript
definition on `@sourcefed/sdk` and run by the daemon like the built-in ones:
polled or pushed, deduplicated, triaged and delivered. Every built-in source is
such a definition.

The plan is [#31][plan]. It ships in slices, each in a release candidate with a
recording.

| Slice | Status | You can |
| --- | --- | --- |
| [P0 SDK and golden tests][p0] | In progress | Run the seven providers on the SDK |
| P1 schedule, jira-query, jira | Planned | These three as first-party plugins |
| P1b timer | Planned | Set a one-shot timer or an interval as a monitor |
| P2 yab | Planned | Yab through the daemon's `mcp` |
| P3 github-issues, github | Planned | Both with the shared budget, wake, webhook |
| P4 slack | Planned | Slack with its limiter, user cache and webhook |
| P5 own plugins | Planned | Load plugins from `~/.config/sourcefed/plugins/` |

P0 is merged to main. It waits for its release candidate and recording.

[plan]: https://github.com/wrkhse/sourcefed/issues/31
[p0]: p0-sdk.md
