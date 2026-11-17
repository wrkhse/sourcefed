# Replay fixtures

Copied byte for byte from `wrkhse/chauffeur`, `crates/protocol/fixtures/`, at
`ab16f20f8cdcfa60bdf32794ab191ee066dd0320` (Chauffeur PR #30, branch
`fix/protocol-follow-ups`). The copies are read-only: never edit either file.
Refresh them by copying both again from the new commit.

| File | SHA-256 |
| --- | --- |
| `sourcefed-events.json` | `d7b0beb75840ce02591e413e036027038bd4991c2c8ee12e15c22e2ab6ad89eb` |
| `sourcefed-events.v1.json` | `6557fbeafeab0cf8345f806d4343314a66616f1dab2a914f6fc74e2a2a539cd9` |

`sourcefed-events.json` holds twelve labelled events from v1's event-gate
categories. Each case carries its `id`, the monitor's `monitor_source`, an
optional `subject` title, the `v1.params` v1 was asked, the gate's
`expected.deliver` verdict, and the `evidence` sourcefed's builder makes
from them.

`sourcefed-events.v1.json` holds the v1 replies, recorded 2026-11-17
against v1 0.1.0: for each case the `params` it answered, its `deliver`
verdict, the `reply` effects and `elapsed_ms`. v1 matched every label when
recorded, so `replies[id].deliver` equals each case's
`expected.deliver`.

`replay.test.ts` builds each monitor and event from a case and asserts the
evidence matches. A change on either side must keep that test passing:
refresh both files from the new commit, then run it again.
