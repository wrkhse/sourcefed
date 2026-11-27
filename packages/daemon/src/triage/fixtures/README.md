# Replay fixtures

Copied from `wrkhse/chauffeur`, `crates/protocol/fixtures/`, at v2
`5ef2b2fbf9338a174392166b17b3b5066a55ce89` (Chauffeur PR #30), with one
hand-written expectation case, `opencode-review-verdict`, marked
`origin: hand-written` in both files. That case is not recorded v1 output.
Refresh them by copying both again from the new commit.

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `sourcefed-events.json`    | `6dc0384aa29d223a532811442f1185c38a77a80b4f9ffea80c3fec9e3ec83f02` |
| `sourcefed-events.v1.json` | `dde604aff52206393506cfaee1de6beb83971a49e0649a2e12e084e7325fc8c0` |

`sourcefed-events.json` holds thirteen labelled events from v1's event-gate
categories. Each case carries its `id`, the monitor's `monitor_source`, an
optional `subject` title, the `v1.params` v1 was asked, the gate's
`expected.deliver` verdict, and the `evidence` sourcefed's builder makes
from them.

`sourcefed-events.v1.json` holds the v1 replies, recorded 2026-11-17
against v1 0.1.0: for each case the `params` it answered, its `deliver`
verdict, the `reply` effects and `elapsed_ms`. The recorded cases matched
every label, and the hand-written `opencode-review-verdict` expectation is
reflected here too, so `replies[id].deliver` equals each case's
`expected.deliver`.

`replay.test.ts` builds each monitor and event from a case and asserts the
evidence matches. A change on either side must keep that test passing:
refresh both files from the new commit, then run it again.
