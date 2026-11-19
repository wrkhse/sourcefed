# Source plugins

Built-in sources use the
[source plugin SDK](../../packages/sdk/README.md): the daemon polls them or
receives their webhooks, then deduplicates, triages and delivers their events.

| Slice | Status | You can |
| --- | --- | --- |
| [P0 SDK and golden tests][p0] | Implemented (0.6.0-rc.1) | Run the seven providers on the SDK |
| [P1b timer][p1b] | Implemented (0.6.0-rc.2) | Set one-shot and interval timers as monitors |

See the [timer package](../../providers/timer/README.md) for its inputs
and behavior. The [source and plugin API RFC][rfc] describes the proposed
design; the closed [#31][archive] records the migration scope.

[p0]: p0-sdk.md
[p1b]: p1b-timer.md
[rfc]: https://github.com/wrkhse/sourcefed/issues/56
[archive]: https://github.com/wrkhse/sourcefed/issues/31
