# Source plugins

Built-in sources use the
[source plugin SDK](../../packages/sdk/README.md): the daemon polls them or
receives their webhooks, then deduplicates, triages and delivers their events.

- [P0: the SDK and golden tests][p0], in 0.6.0-rc.1: the seven built-in
  sources run on the SDK, verified by recorded transcripts.
- [P1b: timers][p1b], in 0.6.0-rc.2: one-shot and interval timers as
  monitors; the [timer package](../../providers/timer/README.md) has its
  inputs and behavior.
- [P2: eventBefore filter][p2], in progress: a bounded verdict seam before
  commit, verified by unit tests; the end-to-end check waits for the framed
  client.
- [P3: framed eventBefore client][p3], planned: a framed EventBefore client
  over tack's daemon socket, pinned to tack_protocol; waits on the daemon hook
  and barn's engine.
- [P4: github-issues Luau source][p4], planned: a Luau source table in a barn
  stall with author filled so quiet-bots can drop [bot] events; follows P3.

Planned source and plugin work is in the [source and plugin API RFC][rfc]; the
closed [#31][archive] records the migration scope.

[p0]: p0-sdk.md
[p1b]: p1b-timer.md
[p2]: p2-event-before.md
[p3]: p3-framed-client.md
[p4]: p4-github-issues-source.md
[rfc]: https://github.com/wrkhse/sourcefed/issues/56
[archive]: https://github.com/wrkhse/sourcefed/issues/31
