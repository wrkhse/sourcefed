//! Real-socket contract tests for the framed `eventBefore` client.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};
use sourcefed_core::event_before_framed::FramedEventBefore;
use sourcefed_core::{
    BeforeVerdict, Event, EventBefore, EventId, EventKind, EventSubject,
    HOOK_ANNOTATIONS_REASON, HOOK_CONNECT_REASON, HOOK_DAEMON_ERROR_REASON,
    HOOK_DECODE_REASON, HOOK_ID_REASON, HOOK_PEER_CLOSED_REASON,
    HOOK_REWRITE_REFUSED_REASON, HOOK_UNKNOWN_OUTCOME_REASON, HOOK_VERSION_REASON,
    SourceName,
};
use tack_protocol::wire::{PROTOCOL_VERSION, encode_line, read_line};

/// One verdict exchange never waits longer than this in a test.
const BUDGET: Duration = Duration::from_secs(2);

/// A listener on a temporary socket path, removed when the test ends.
struct Daemon {
    listener: UnixListener,
    socket: PathBuf,
    _dir: tempfile::TempDir,
}

impl Daemon {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("hook.sock");
        let listener = UnixListener::bind(&socket).unwrap();

        Self {
            listener,
            socket,
            _dir: dir,
        }
    }

    fn client(&self) -> FramedEventBefore {
        FramedEventBefore::new(&self.socket, "quiet-bots")
    }
}

fn event() -> Event {
    let source = SourceName::new("timer".into()).unwrap();
    let subject = EventSubject::new(source, "subject".into()).unwrap();
    let at = "2026-01-01T00:00:00Z".parse().unwrap();
    let event = Event::new(
        EventId::new("evt-1".into()).unwrap(),
        EventKind::TimerFired,
        subject,
        "fired".into(),
        at,
    )
    .unwrap();

    event.with_author(Some("steven".into())).unwrap()
}

/// Reads one request, checks the wire contract, then writes the reply frame.
/// Joining the worker returns the request for further assertions.
fn serve<F>(listener: UnixListener, reply: F) -> JoinHandle<Value>
where
    F: FnOnce(u64) -> Option<Vec<u8>> + Send + 'static,
{
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request: Value = {
            let mut reader = BufReader::new(&mut stream);
            let frame = read_line(&mut reader).unwrap().unwrap();

            serde_json::from_slice(&frame).unwrap()
        };

        assert_eq!(request.get("kind").and_then(Value::as_str), Some("hook"));
        assert_eq!(
            request.get("hook").and_then(Value::as_str),
            Some("eventBefore")
        );
        assert_eq!(
            request.get("version").and_then(Value::as_u64),
            Some(u64::from(PROTOCOL_VERSION))
        );

        let call = request.get("call").unwrap();
        assert_eq!(call.get("tool"), Some(&json!("sourcefed")));
        assert_eq!(call.get("name"), Some(&json!("quiet-bots")));
        assert!(call.get("session_id").is_some_and(Value::is_null));

        let input = call.get("input").unwrap();
        assert_eq!(input.get("id"), Some(&json!("evt-1")));
        assert_eq!(input.get("author"), Some(&json!("steven")));

        let id = request.get("id").and_then(Value::as_u64).unwrap();
        if let Some(frame) = reply(id) {
            stream.write_all(&frame).unwrap();
        }

        request
    })
}

fn hook_reply(id: u64, outcome: Value) -> Vec<u8> {
    let reply = json!({
        "kind": "hook",
        "id": id,
        "version": PROTOCOL_VERSION,
        "outcome": outcome,
    });

    encode_line(&reply).unwrap()
}

#[test]
fn allow_keeps_the_event_and_sends_the_hook_request() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(id, json!({ "kind": "allow" })))
    });

    let verdict = client.verdict(&event(), BUDGET);
    let request = worker.join().unwrap();

    assert_eq!(verdict, Ok(BeforeVerdict::Keep));
    assert_eq!(request.get("id").and_then(Value::as_u64), Some(1_u64));
}

#[test]
fn drop_reports_the_hook_name() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(id, json!({ "kind": "drop" })))
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(
        verdict,
        Ok(BeforeVerdict::Drop {
            reason: "plugin-drop:quiet-bots".into(),
        })
    );
}

#[test]
fn deny_reports_the_hook_name_and_the_reason() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(
            id,
            json!({ "kind": "deny", "reason": "bot author" }),
        ))
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(
        verdict,
        Ok(BeforeVerdict::Drop {
            reason: "plugin-deny:quiet-bots:bot author".into(),
        })
    );
}

#[test]
fn annotate_converts_fields_to_validated_strings() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(
            id,
            json!({ "kind": "annotate", "fields": { "team": "core", "count": 7 } }),
        ))
    });

    let verdict = client.verdict(&event(), BUDGET);
    let fields = BTreeMap::from([
        ("count".to_owned(), "7".to_owned()),
        ("team".to_owned(), "core".to_owned()),
    ]);

    worker.join().unwrap();
    assert_eq!(verdict, Ok(BeforeVerdict::Annotate { fields }));
}

#[test]
fn invalid_annotations_are_refused_with_a_named_reason() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(
            id,
            json!({ "kind": "annotate", "fields": { "team": "" } }),
        ))
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_ANNOTATIONS_REASON.to_owned()));
}

#[test]
fn rewrite_is_refused_with_a_named_reason() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(
            id,
            json!({ "kind": "rewrite", "input": { "id": "evt-2" } }),
        ))
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_REWRITE_REFUSED_REASON.to_owned()));
}

#[test]
fn a_version_mismatch_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        let reply = json!({
            "kind": "hook",
            "id": id,
            "version": PROTOCOL_VERSION.wrapping_add(1),
            "outcome": { "kind": "allow" },
        });

        Some(encode_line(&reply).unwrap())
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_VERSION_REASON.to_owned()));
}

#[test]
fn an_id_mismatch_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        let reply = json!({
            "kind": "hook",
            "id": id.wrapping_add(1),
            "version": PROTOCOL_VERSION,
            "outcome": { "kind": "allow" },
        });

        Some(encode_line(&reply).unwrap())
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_ID_REASON.to_owned()));
}

#[test]
fn a_daemon_error_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        let reply = json!({
            "kind": "error",
            "id": id,
            "version": PROTOCOL_VERSION,
            "error": "daemon_error",
            "message": "hook busy",
        });

        Some(encode_line(&reply).unwrap())
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_DAEMON_ERROR_REASON.to_owned()));
}

#[test]
fn a_tool_reply_is_an_unknown_outcome() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        let reply = json!({
            "kind": "tool",
            "id": id,
            "version": PROTOCOL_VERSION,
            "content": [],
        });

        Some(encode_line(&reply).unwrap())
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned()));
}

#[test]
fn an_unknown_outcome_kind_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |id| {
        Some(hook_reply(id, json!({ "kind": "surprise" })))
    });

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned()));
}

#[test]
fn a_closed_peer_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |_| None);

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_PEER_CLOSED_REASON.to_owned()));
}

#[test]
fn a_malformed_reply_is_a_named_error() {
    let daemon = Daemon::new();
    let client = daemon.client();
    let worker = serve(daemon.listener, |_| Some(b"not json\n".to_vec()));

    let verdict = client.verdict(&event(), BUDGET);

    worker.join().unwrap();
    assert_eq!(verdict, Err(HOOK_DECODE_REASON.to_owned()));
}

#[test]
fn a_missing_socket_is_a_connect_error() {
    let dir = tempfile::tempdir().unwrap();
    let client =
        FramedEventBefore::new(dir.path().join("missing.sock"), "quiet-bots");

    assert_eq!(
        client.verdict(&event(), BUDGET),
        Err(HOOK_CONNECT_REASON.to_owned())
    );
}
