# P3: framed eventBefore client

**Status: In progress.** A sourcefed client asks tack's daemon to run an
`eventBefore` hook over a framed socket before `store.commit()`. The framed
client, the git-pinned protocol dependency, the outcome mapping and annotation
support have landed. The real-socket proof waits on tack#23 PR4. The [RFC][rfc]
tracks the work. The first end-to-end proof runs with [P4][p4].

## You can

Drop bot-authored events in a running Rust engine using P2's `EventBefore`
trait. One poll carries `author=deploy-bot` and `author=steven`: the hook
returns `Drop { reason: "plugin-drop:quiet-bots" }` and `Keep` respectively;
only steven enters pending.

## The path of a verdict

```mermaid
flowchart LR
    Source["source.poll()<br/>events with author"] --> Engine
    Engine["PollEngine<br/>commit(outcome)"]
    Engine --> Client["FramedEventBefore<br/>EventBefore impl"]
    Client -->|"Request::Hook<br/>eventBefore"| Daemon
    Daemon["tack daemon<br/>hook dispatch"]
    Daemon -->|"stall call"| Barn["barn engine<br/>Luau stall"]
    Barn -->|"BeforeVerdict"| Daemon
    Daemon -->|"Reply::Hook"| Client
    Client -->|"Keep / Drop {reason}"| Store["store.commit<br/>skipped ids seen"]
```

## Parts

### 1. Git-pinned protocol dependency

sourcefed depends on `tack_protocol` from `crates/protocol` in wrkhse/tack,
git-pinned at rev `197ba009f88e296a8cab28b82ebb3db2b33833fb` as tack pins barn.
`cargo-deny` allows that git source through `allow-git` in `rust/deny.toml`.
There is no tack-client crate, and sourcefed never launches barn.

Files: `rust/crates/core/Cargo.toml`, `rust/Cargo.lock`, `rust/deny.toml`.

```toml
[dependencies.tack_protocol]
version = "0.1.0-rc.6"
git = "https://github.com/wrkhse/tack"
rev = "197ba009f88e296a8cab28b82ebb3db2b33833fb"
```

**Verified by** `allow_keeps_the_event_and_sends_the_hook_request` for the
`Request::Hook` wire shape, `a_version_mismatch_is_a_named_error` and
`an_id_mismatch_is_a_named_error` for reply checks against the pinned crate,
and `cargo deny` accepting the git source.

### 2. Framed client

`FramedEventBefore::new(socket_path, hook_name)` implements `EventBefore`,
maps an `Event` to the hook payload, and uses the trait budget as its deadline.
The client adds `BeforeVerdict::Annotate` and a bounded, backward-compatible
`Event.annotations` map with validated keys and values. `EventBefore` stays
unchanged for existing callers: the `budget` argument, `#[non_exhaustive]`
on `BeforeVerdict` and the `AllowAll` hook stay.
Every failure keeps the event with a named reason: timeout, connect error,
decode error, peer closed, daemon error, version or id mismatch, invalid
annotations, a refused rewrite, or an unknown outcome kind.

Files: `rust/crates/core/src/event_before_framed.rs`,
`rust/crates/core/src/event.rs`,
`rust/crates/core/src/lib.rs`, and
`rust/crates/core/tests/event_before_framed.rs` for local socket tests.

```rust
let hook = FramedEventBefore::new(socket_path, hook_name);

let engine = PollEngine::new(config, source, store, clock)?
    .with_event_before(Arc::new(hook), EVENT_BEFORE_TIMEOUT);
```

**Verified by** `a_missing_socket_path_is_untrusted`,
`a_closed_peer_is_a_named_error`, `a_malformed_reply_is_a_named_error`,
`a_daemon_error_is_a_named_error` and `a_tool_reply_is_an_unknown_outcome`
for the failure paths. `invalid_annotations_keep_the_event_without_fields`,
`an_annotating_hook_keeps_validated_fields` and
`a_named_hook_error_is_used_as_the_reason_verbatim` cover the seam in
`event_before.rs`; `with_annotations_accepts_bounded_fields`,
`with_annotations_rejects_unbounded_fields` and
`annotations_default_and_round_trip_when_present` cover `event.rs`.

### 3. Daemon hook and barn stall

tack's daemon registers the `eventBefore` hook and barn's engine invokes the
stall. sourcefed calls it over the socket.

Files: none in this repo; tack and barn slices own this work.

**Verified by** no test in this repo: tack and barn own the daemon and stall.
The joint proof waits on tack#23 PR4.

### 4. Verdict mapping

| Outcome               | sourcefed decision                                   |
| --------------------- | ---------------------------------------------------- |
| `allow`               | Keep                                                 |
| `drop`                | Drop with reason `plugin-drop:<plugin>`              |
| `deny { reason }`     | Drop with `plugin-deny:<plugin>:<reason>`            |
| `annotate { fields }` | Keep with the fields applied                         |
| `rewrite { input }`   | Keep original; reason `event-before-rewrite-refused` |
| Unknown outcome kind  | Keep with its own named reason, logged and counted   |
| Boundary failure      | Keep with its own named reason, logged and counted   |

Wire `drop` carries no reason. Boundary failures include timeout, connect
error, decode error, peer closed, and version or id mismatch.

**Verified by** `allow_keeps_the_event_and_sends_the_hook_request`,
`drop_reports_the_hook_name`, `deny_reports_the_hook_name_and_the_reason`,
`annotate_converts_fields_to_validated_strings`,
`invalid_annotations_are_refused_with_a_named_reason`,
`rewrite_is_refused_with_a_named_reason`,
`an_unknown_outcome_kind_is_a_named_error` and
`a_tool_reply_is_an_unknown_outcome` for the outcomes; and
`a_version_mismatch_is_a_named_error`, `an_id_mismatch_is_a_named_error`,
`a_daemon_error_is_a_named_error`, `a_closed_peer_is_a_named_error`,
`a_malformed_reply_is_a_named_error` and
`a_missing_socket_path_is_untrusted` for the boundaries.

## Hook contract

The hook identifier is exactly `eventBefore`. The closed registry is
`hook_kind` in tack's `crates/protocol/src/wire.rs:29-35`.

Requests are `Request::Hook` with `kind: "hook"`, `id: u64`,
`version: u32`, `hook: "eventBefore"`, `call`, and `_meta`
(wire.rs:68-79, 100-107). The call is a `ToolCall` containing `tool`, `name`,
`input`, and `session_id`. The protocol sets
`PROTOCOL_VERSION = 1` (wire.rs:15). The event travels in `call.input`;
`tool` and `name` are required strings.

Framing is one NDJSON line through `encode_line` and `read_line`, with
`MAX_FRAME_BYTES` from the protocol crate (wire.rs:258-310). sourcefed does
not copy the limits.

Replies are `Reply::Hook { kind, id, version, outcome }` (wire.rs:143-149).
The tagged outcome kinds are `allow`, `deny { reason }`, `rewrite { input }`,
`annotate { fields }`, and `drop` (wire.rs:121-134).

tack's daemon path is on main (`daemon/src/main.rs:163-188` through
`frames.rs`); no wire or daemon change is needed.

## Open questions

- What Luau `ctx.emit` shape carries `author` for the github-issues source?
- What bound applies to its source cursor?

## Structure

A verdict is one of three kinds. `Annotate` carries the fields the engine
applies to an event; `BeforeVerdict` is `#[non_exhaustive]`, so callers handle
future kinds. A `Drop` carries the reason logged for the skipped event.

```rust
pub enum BeforeVerdict {
    Keep,
    Drop { reason: String },
    Annotate { fields: BTreeMap<String, String> },
}
```

A decision is what the engine applies. `Keep` carries the failure reason that
kept the event, when one exists, and the fields to apply. Invalid annotation
fields keep the event with no fields.

```rust
pub(crate) enum BeforeDecision {
    Keep {
        reason: Option<String>,
        annotations: BTreeMap<String, String>,
    },
    Drop { reason: String },
}
```

The client opens one connection per verdict and bounds it by the trait's
budget. It refuses a reply whose id or version differs, and names every
failure path.

```rust
pub struct FramedEventBefore {
    socket: PathBuf,
    hook_name: String,
    next_id: AtomicU64,
}

impl FramedEventBefore {
    pub fn new(
        socket: impl Into<PathBuf>,
        hook_name: impl Into<String>,
    ) -> Self;
}

impl EventBefore for FramedEventBefore {
    fn verdict(
        &self,
        event: &Event,
        budget: Duration,
    ) -> Result<BeforeVerdict, String>;
}
```

Annotations are a bounded `BTreeMap` on the event. Older state loads with an
empty map; `with_annotations` rejects too many fields and empty, oversized or
control-containing keys and values.

```rust
pub struct Event {
    annotations: BTreeMap<String, String>,
}

impl Event {
    pub fn annotations(&self) -> &BTreeMap<String, String>;

    pub fn with_annotations(
        &self,
        fields: BTreeMap<String, String>,
    ) -> Result<Self, ModelError>;

    pub(crate) fn validate_annotations(
        fields: &BTreeMap<String, String>,
    ) -> Result<(), ModelError>;
}
```

Every failure path has one named reason. The seam keeps the event for each.

```rust
pub const HOOK_SOCKET_UNTRUSTED_REASON: &str = "event-before-socket-untrusted";
pub const HOOK_DECODE_REASON: &str = "event-before-decode";
pub const HOOK_PEER_CLOSED_REASON: &str = "event-before-peer-closed";
pub const HOOK_VERSION_REASON: &str = "event-before-version-mismatch";
pub const HOOK_ID_REASON: &str = "event-before-id-mismatch";
pub const HOOK_UNKNOWN_OUTCOME_REASON: &str = "event-before-unknown-outcome";
pub const HOOK_REWRITE_REFUSED_REASON: &str = "event-before-rewrite-refused";
pub const HOOK_ANNOTATIONS_REASON: &str = "event-before-annotations-invalid";
pub const HOOK_DAEMON_ERROR_REASON: &str = "event-before-daemon-error";
```

## Decided

| Choice                                                 | By         | When       |
| ------------------------------------------------------ | ---------- | ---------- |
| git-pin `tack_protocol` by rev, the way tack pins barn | owner      | 2026-11-28 |
| eventBefore outcome mapping                            | supervisor | 2026-11-28 |

sourcefed writes its own client against tack's daemon socket.

An event filter keeps on failure, as if no filter ran; dropping on failure
would lose real events. Every failure path is named and observable. Tool hooks
keep deny-on-failure; the difference is per hook kind and is recorded in
tack#23's Decided table.

## End to end

The joint proof is owned with tack#23 PR4 and hosted in tack's CI; sourcefed
supplies the Luau source table and framed client. It drops a bot event,
annotates a non-bot event with its fields, and keeps an event at a broken
boundary with a named reason.

[p4]: p4-github-issues-source.md
[rfc]: https://github.com/wrkhse/sourcefed/issues/56
