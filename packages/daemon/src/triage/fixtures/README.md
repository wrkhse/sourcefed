# Replay fixtures

Copied byte for byte from `wrkhse/chauffeur`, `crates/protocol/fixtures/`, at v2
`5ef2b2fbf9338a174392166b17b3b5066a55ce89` (Chauffeur PR #30). The copies are
read-only: never edit either file. Refresh them by copying both again from the new
commit.

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `sourcefed-events.json`    | `a5da5d030cbc73f3cba867f94dd1e89eea38ce8935f8435c71b9136f72d3758e` |
| `sourcefed-events.v1.json` | `9d0ff82288823d39828de26b1e1c3051ea2e289308613dc82d2c1108e13cb525` |

`sourcefed-events.json` holds thirteen labelled events from v1's event-gate
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
