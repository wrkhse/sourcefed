# P3: framed eventBefore client

**Status: Planned.** A sourcefed client asks tack's daemon to run an
`eventBefore` hook over a framed socket before `store.commit()`. The slice
waits on barn's engine (barn#72, barn#74); no code lands until the plan is
approved. The [RFC][rfc] tracks the work.
The first end-to-end proof runs with [P4][p4].
The real-socket proof waits on tack's hook.

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
git-pinned by rev as tack pins barn. There is no tack-client crate, and
sourcefed never launches barn.

Files: `rust/crates/core/Cargo.toml`, `rust/Cargo.lock`.

```toml
tack_protocol = { git = "https://github.com/wrkhse/tack", rev = "<pinned rev>" }
```

**Verified by** the CI dependency check `cargo tree -i tack_protocol --locked`
and codec tests decoding `tack_protocol` `Request::Hook` and `Reply::Hook`.

### 2. Framed client

`FramedEventBefore::new(socket_path, hook_name)` implements `EventBefore`,
maps an `Event` to the hook payload, and uses the trait budget as its deadline.
The client adds `BeforeVerdict::Annotate` and a bounded, backward-compatible
`Event.annotations` map with validated keys and values. `EventBefore` stays
unchanged for existing callers: the `budget` argument, `#[non_exhaustive]`
on `BeforeVerdict` and the `AllowAll` hook stay.
Every failure keeps the event with a named reason: timeout, connect error,
decode error, peer closed, version or id mismatch, or an unknown outcome kind.

Files: `rust/crates/core/src/event_before_framed.rs`,
`rust/crates/core/src/event.rs`,
`rust/crates/core/src/lib.rs`, and
`rust/crates/core/tests/event_before_framed.rs` for the real-socket test.

```rust
let hook = FramedEventBefore::new(socket_path, hook_name);

let engine = PollEngine::new(config, source, store, clock)?
    .with_event_before(Arc::new(hook), EVENT_BEFORE_TIMEOUT);
```

**Verified by** codec, deadline and failure tests in the module, and a
real-socket contract test against tack's hook.

### 3. Daemon hook and barn stall

tack's daemon registers the `eventBefore` hook and barn's engine invokes the
stall. sourcefed calls it over the socket.

Files: none in this repo; tack and barn slices own this work.

**Verified by** the end-to-end check with a real daemon and stall.

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

**Verified by** mapping and failure tests for each outcome and boundary failure.

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

The single joint proof is owned with tack#23 PR4 and hosted in tack's CI.
sourcefed supplies the Luau source table and framed client. A real sourcefed
session drops a bot event, annotates a non-bot event with its fields, and keeps
an event at a broken boundary with a named reason.

[p4]: p4-github-issues-source.md
[rfc]: https://github.com/wrkhse/sourcefed/issues/56
