# Source plugins

A source plugin is a new kind of source, written as a small TypeScript
definition on `@sourcefed/sdk` and run by the daemon like the built-in ones:
polled or pushed, deduplicated, triaged and delivered. Every built-in source is
such a definition.

The plan is [#31][plan]. It ships in slices, each in a release candidate with a
recording.

| Slice | Status | You can |
| --- | --- | --- |
| [P0 SDK and golden tests][p0] | Implemented (0.6.0-rc.1) | Run the seven providers on the SDK |
| P1 schedule, jira-query, jira | Planned (waits on barn) | Run them as plugins |
| [P1b timer][p1b] | Implemented (0.6.0-rc.2) | Set one-shot and interval timers as monitors |
| P2 yab | Planned (waits on barn) | Read Yab with no process per poll |
| P3 github-issues and github | Planned (waits on barn) | Use one budget per token |
| P4 slack | Planned (waits on barn) | Slack with its limiter, user cache, webhook |
| P5 your own plugins | Planned | Load plugins from `~/.config/sourcefed/plugins/` |
| [P6 source authoring API][p6] | Planned | Author a source in one definition |

What each later slice builds:

- **P1** runs schedule, jira-query and jira as plugins in sourcefed's stall
  under barn. It needs barn B1 and B2.
- **P1b** adds one-shot and interval timers as monitors, in-process on today's
  daemon; see its [recording][p1b-recording].
- **P2** reads Yab through barn's `mcp.call`, with no process per poll. It
  needs barn B3.
- **P3** gives github-issues and github the shared per-token budget and the
  webhook verified by barn. It needs barn B4.
- **P4** gives slack its limiter, user cache and webhook. It needs barn B4.

P0 is in [0.6.0-rc.1][rc]; its [recording][p0-recording] shows two real events.

[plan]: https://github.com/wrkhse/sourcefed/issues/31
[p0]: p0-sdk.md
[p0-recording]: p0-sdk.md#recording
[p1b-recording]: p1b-timer.md#recording
[p1b]: p1b-timer.md
[p6]: p6-authoring-api.md
[rc]: https://github.com/wrkhse/sourcefed/releases/tag/v0.6.0-rc.1
