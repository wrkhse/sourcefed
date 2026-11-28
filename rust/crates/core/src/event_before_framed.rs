//! An [`EventBefore`] hook that asks tack's daemon over a framed socket.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::io::Errno;
use rustix::net::{
    AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with,
    sockopt::socket_error,
};

use serde_json::Value;
use tack_protocol::MAX_FRAME_BYTES;
use tack_protocol::wire::{
    Outcome, PROTOCOL_VERSION, Reply, Request, ToolCall, encode_line,
};

use crate::event::Event;
use crate::{
    BeforeVerdict, EventBefore, HOOK_ANNOTATION_TYPE_REASON,
    HOOK_ANNOTATIONS_REASON, HOOK_CONNECT_REASON, HOOK_CONNECT_TIMEOUT_REASON,
    HOOK_DAEMON_ERROR_REASON, HOOK_DECODE_REASON, HOOK_ENCODE_REASON,
    HOOK_ID_REASON, HOOK_PEER_CLOSED_REASON, HOOK_REWRITE_REFUSED_REASON,
    HOOK_SOCKET_UNTRUSTED_REASON, HOOK_TIMEOUT_REASON, HOOK_UNKNOWN_OUTCOME_REASON,
    HOOK_VERSION_REASON, validate_text,
};

/// Longest wire deny reason accepted before it is logged.
const MAX_PLUGIN_REASON_LEN: usize = 256;

/// Asks one named `eventBefore` hook for a verdict over one Unix socket.
///
/// Each call opens a new connection. One deadline bounds validation, connect,
/// write, read and decoding; a failed exchange keeps the event with a named
/// reason.
pub struct FramedEventBefore {
    socket: PathBuf,
    hook_name: String,
    next_id: AtomicU64,
}

impl FramedEventBefore {
    /// Builds a hook that calls `hook_name` on the daemon at `socket`.
    #[must_use]
    pub fn new(socket: impl Into<PathBuf>, hook_name: impl Into<String>) -> Self {
        Self {
            socket: socket.into(),
            hook_name: hook_name.into(),
            next_id: AtomicU64::new(1),
        }
    }

    fn ask(&self, event: &Event, budget: Duration) -> Result<BeforeVerdict, String> {
        let deadline = Instant::now()
            .checked_add(budget)
            .unwrap_or_else(Instant::now);
        let (id, frame) = self.request(event)?;

        let reply = self.exchange(&frame, deadline)?;

        self.decide(reply, id)
    }

    fn request(&self, event: &Event) -> Result<(u64, Vec<u8>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let input = serde_json::to_value(event)
            .map_err(|_| HOOK_ENCODE_REASON.to_owned())?;
        let request = Request::Hook {
            id,
            version: PROTOCOL_VERSION,
            hook: "eventBefore".into(),
            call: ToolCall {
                tool: "sourcefed".into(),
                name: self.hook_name.clone(),
                input,
                session_id: None,
            },
            _meta: None,
        };
        let frame =
            encode_line(&request).map_err(|_| HOOK_ENCODE_REASON.to_owned())?;

        Ok((id, frame))
    }

    fn exchange(&self, frame: &[u8], deadline: Instant) -> Result<Value, String> {
        let mut stream = connect_within(&self.socket, deadline)?;

        exchange_stream(&mut stream, frame, deadline)
    }

    fn decide(&self, value: Value, id: u64) -> Result<BeforeVerdict, String> {
        verify(&value, id)?;

        let outcome = value.get("outcome");
        let deny_without_reason = outcome
            .and_then(|outcome| outcome.get("kind"))
            .and_then(Value::as_str)
            == Some("deny")
            && !outcome
                .and_then(|outcome| outcome.get("reason"))
                .is_some_and(Value::is_string);
        if deny_without_reason {
            return Ok(BeforeVerdict::Drop {
                reason: format!("plugin-deny:{}:invalid-reason", self.hook_name),
            });
        }

        let reply: Reply = serde_json::from_value(value)
            .map_err(|_| HOOK_DECODE_REASON.to_owned())?;
        let Reply::Hook { outcome, .. } = reply else {
            return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned());
        };

        match outcome {
            Outcome::Allow => Ok(BeforeVerdict::Keep),
            Outcome::Drop => Ok(BeforeVerdict::Drop {
                reason: format!("plugin-drop:{}", self.hook_name),
            }),
            Outcome::Deny { reason } => {
                if validate_text(&reason, "plugin reason", MAX_PLUGIN_REASON_LEN)
                    .is_err()
                {
                    return Ok(BeforeVerdict::Drop {
                        reason: format!(
                            "plugin-deny:{}:invalid-reason",
                            self.hook_name,
                        ),
                    });
                }

                Ok(BeforeVerdict::Drop {
                    reason: format!("plugin-deny:{}:{}", self.hook_name, reason),
                })
            }
            Outcome::Rewrite { .. } => Err(HOOK_REWRITE_REFUSED_REASON.to_owned()),
            Outcome::Annotate { fields } => {
                let fields = annotation_fields(fields)?;

                Ok(BeforeVerdict::Annotate { fields })
            }
        }
    }
}

impl EventBefore for FramedEventBefore {
    /// Asks the daemon for one verdict within `budget`.
    ///
    /// # Errors
    /// Returns the named reason for any boundary or mapping failure.
    fn verdict(
        &self,
        event: &Event,
        budget: Duration,
    ) -> Result<BeforeVerdict, String> {
        self.ask(event, budget)
    }
}

// Writes the request and reads one reply frame over an already-open stream.
fn exchange_stream(
    stream: &mut UnixStream,
    frame: &[u8],
    deadline: Instant,
) -> Result<Value, String> {
    write_frame(stream, frame, deadline)?;

    read_frame(stream, deadline)
}

fn write_frame(
    stream: &mut UnixStream,
    frame: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    let left = remaining(deadline)?;
    stream
        .set_write_timeout(Some(left))
        .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

    stream.write_all(frame).map_err(|error| {
        if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
            HOOK_TIMEOUT_REASON.to_owned()
        } else {
            HOOK_CONNECT_REASON.to_owned()
        }
    })
}

fn read_frame(stream: &mut UnixStream, deadline: Instant) -> Result<Value, String> {
    let mut frame = Vec::new();
    let mut chunk = [0_u8; 512];

    'frame: loop {
        let left = remaining(deadline)?;
        stream
            .set_read_timeout(Some(left))
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

        let read = match stream.read(&mut chunk) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock
                ) =>
            {
                return Err(HOOK_TIMEOUT_REASON.to_owned());
            }
            Err(_) => return Err(HOOK_CONNECT_REASON.to_owned()),
        };

        if read == 0 {
            return Err(HOOK_PEER_CLOSED_REASON.to_owned());
        }

        for byte in chunk.iter().take(read) {
            frame.push(*byte);

            if frame.len() > MAX_FRAME_BYTES {
                return Err(HOOK_DECODE_REASON.to_owned());
            }

            if *byte == b'\n' {
                break 'frame;
            }
        }
    }

    serde_json::from_slice(&frame).map_err(|_| HOOK_DECODE_REASON.to_owned())
}

// Checks the envelope before interpreting the outcome, error replies included.
fn verify(value: &Value, id: u64) -> Result<(), String> {
    if value.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(HOOK_ID_REASON.to_owned());
    }
    if value.get("version").and_then(Value::as_u64)
        != Some(u64::from(PROTOCOL_VERSION))
    {
        return Err(HOOK_VERSION_REASON.to_owned());
    }

    match value.get("kind").and_then(Value::as_str) {
        Some("hook") => {}
        Some("error") => return Err(HOOK_DAEMON_ERROR_REASON.to_owned()),
        _ => return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned()),
    }

    let known = ["allow", "deny", "rewrite", "annotate", "drop"];
    let kind = value
        .get("outcome")
        .and_then(|outcome| outcome.get("kind"))
        .and_then(Value::as_str);

    if !kind.is_some_and(|kind| known.contains(&kind)) {
        return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned());
    }

    Ok(())
}

fn annotation_fields(
    fields: serde_json::Map<String, Value>,
) -> Result<BTreeMap<String, String>, String> {
    let fields: BTreeMap<String, String> = fields
        .into_iter()
        .map(|(key, value)| {
            let Value::String(text) = value else {
                return Err(HOOK_ANNOTATION_TYPE_REASON.to_owned());
            };

            Ok((key, text))
        })
        .collect::<Result<_, _>>()?;

    Event::validate_annotations(&fields)
        .map_err(|_| HOOK_ANNOTATIONS_REASON.to_owned())?;

    Ok(fields)
}

// The only source of remaining time for every step of one exchange.
fn remaining(deadline: Instant) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());

    if left.is_zero() {
        return Err(HOOK_TIMEOUT_REASON.to_owned());
    }

    Ok(left)
}

// A peer is trusted only when its socket path and its owner both check out.
fn connect_within(path: &Path, deadline: Instant) -> Result<UnixStream, String> {
    validate_socket(path)?;
    let _ = remaining(deadline)?;

    let address = SocketAddrUnix::new(path)
        .map_err(|_| HOOK_SOCKET_UNTRUSTED_REASON.to_owned())?;
    let fd = socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::NONBLOCK | SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

    // A nonblocking connect cannot outlive the deadline: poll for only the
    // time left, then hand the connected socket back to the timed exchange.
    match connect(&fd, &address) {
        Ok(()) => {}
        Err(Errno::INPROGRESS | Errno::AGAIN) => {
            wait_for_connect(&fd, deadline)?;
        }
        Err(_) => return Err(HOOK_CONNECT_REASON.to_owned()),
    }

    let stream = UnixStream::from(fd);
    stream
        .set_nonblocking(false)
        .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

    Ok(stream)
}

// Waits for a nonblocking connect, retrying only while the budget allows.
fn wait_for_connect(fd: &OwnedFd, deadline: Instant) -> Result<(), String> {
    loop {
        let left = remaining(deadline)
            .map_err(|_| HOOK_CONNECT_TIMEOUT_REASON.to_owned())?;
        let timeout = Timespec::try_from(left)
            .map_err(|_| HOOK_CONNECT_TIMEOUT_REASON.to_owned())?;
        let mut fds = [PollFd::new(fd, PollFlags::OUT)];

        if poll(&mut fds, Some(&timeout))
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?
            == 0
        {
            return Err(HOOK_CONNECT_TIMEOUT_REASON.to_owned());
        }

        let [event] = fds;
        if !event
            .revents()
            .intersects(PollFlags::OUT | PollFlags::ERR | PollFlags::HUP)
        {
            continue;
        }

        match socket_error(fd) {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(Errno::AGAIN | Errno::INPROGRESS)) => {
                let _ = remaining(deadline)
                    .map_err(|_| HOOK_CONNECT_TIMEOUT_REASON.to_owned())?;
            }
            Ok(Err(_)) | Err(_) => return Err(HOOK_CONNECT_REASON.to_owned()),
        }
    }
}

fn validate_socket(path: &Path) -> Result<(), String> {
    let untrusted = || HOOK_SOCKET_UNTRUSTED_REASON.to_owned();

    if !path.is_absolute() {
        return Err(untrusted());
    }

    let metadata = fs::metadata(path).map_err(|_| untrusted())?;
    if !metadata.file_type().is_socket() {
        return Err(untrusted());
    }

    let home = std::env::var_os("HOME").ok_or_else(untrusted)?;
    let expected = fs::metadata(home).map_err(|_| untrusted())?.uid();
    if metadata.uid() != expected {
        return Err(untrusted());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{BufReader, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use rustix::net::{bind, listen};
    use serde_json::{Value, json};

    use crate::{
        BeforeVerdict, Event, EventBefore, EventId, EventKind, EventSubject,
        HOOK_ANNOTATION_TYPE_REASON, HOOK_ANNOTATIONS_REASON,
        HOOK_DAEMON_ERROR_REASON, HOOK_DECODE_REASON, HOOK_ID_REASON,
        HOOK_PEER_CLOSED_REASON, HOOK_REWRITE_REFUSED_REASON,
        HOOK_SOCKET_UNTRUSTED_REASON, HOOK_TIMEOUT_REASON,
        HOOK_UNKNOWN_OUTCOME_REASON, HOOK_VERSION_REASON, SourceName,
    };
    use tack_protocol::wire::{
        MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, ToolCall, encode_line, read_line,
    };

    use super::*;

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

    /// Reads one request, asserts the whole hook request, then writes the reply.
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

            let id = request.get("id").and_then(Value::as_u64).unwrap();
            let expected = Request::Hook {
                id,
                version: PROTOCOL_VERSION,
                hook: "eventBefore".into(),
                call: ToolCall {
                    tool: "sourcefed".into(),
                    name: "quiet-bots".into(),
                    input: serde_json::to_value(event()).unwrap(),
                    session_id: None,
                },
                _meta: None,
            };

            assert_eq!(
                serde_json::from_value::<Request>(request.clone()).unwrap(),
                expected
            );

            if let Some(frame) = reply(id) {
                stream.write_all(&frame).unwrap();
            }

            request
        })
    }

    fn hook_reply(id: u64, outcome: &Value) -> Vec<u8> {
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
            Some(hook_reply(id, &json!({ "kind": "allow" })))
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
            Some(hook_reply(id, &json!({ "kind": "drop" })))
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
                &json!({ "kind": "deny", "reason": "bot author" }),
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
    fn a_deny_with_a_control_character_is_refused() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |id| {
            Some(hook_reply(
                id,
                &json!({ "kind": "deny", "reason": "line\nbreak" }),
            ))
        });

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(
            verdict,
            Ok(BeforeVerdict::Drop {
                reason: "plugin-deny:quiet-bots:invalid-reason".into(),
            })
        );
    }

    #[test]
    fn an_oversized_deny_reason_is_refused() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |id| {
            Some(hook_reply(
                id,
                &json!({ "kind": "deny", "reason": "x".repeat(257) }),
            ))
        });

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(
            verdict,
            Ok(BeforeVerdict::Drop {
                reason: "plugin-deny:quiet-bots:invalid-reason".into(),
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
                &json!({ "kind": "annotate", "fields": { "team": "core", "owner": "alice" } }),
            ))
        });

        let verdict = client.verdict(&event(), BUDGET);
        let fields = BTreeMap::from([
            ("owner".to_owned(), "alice".to_owned()),
            ("team".to_owned(), "core".to_owned()),
        ]);

        worker.join().unwrap();
        assert_eq!(verdict, Ok(BeforeVerdict::Annotate { fields }));
    }

    #[test]
    fn non_string_annotation_fields_are_refused() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |id| {
            Some(hook_reply(
                id,
                &json!({ "kind": "annotate", "fields": { "count": 7 } }),
            ))
        });

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(verdict, Err(HOOK_ANNOTATION_TYPE_REASON.to_owned()));
    }

    #[test]
    fn invalid_annotations_are_refused_with_a_named_reason() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |id| {
            Some(hook_reply(
                id,
                &json!({ "kind": "annotate", "fields": { "team": "" } }),
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
                &json!({ "kind": "rewrite", "input": { "id": "evt-2" } }),
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
            Some(hook_reply(id, &json!({ "kind": "surprise" })))
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
    fn a_close_mid_frame_is_a_named_error() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |_| Some(b"partial".to_vec()));

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(verdict, Err(HOOK_PEER_CLOSED_REASON.to_owned()));
    }

    #[test]
    fn an_oversized_frame_is_a_named_error() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |_| {
            let mut frame = vec![b'x'; MAX_FRAME_BYTES + 1];
            frame.push(b'\n');

            Some(frame)
        });

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(verdict, Err(HOOK_DECODE_REASON.to_owned()));
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
    fn a_peer_that_never_answers_times_out() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = thread::spawn(move || {
            let (_stream, _) = daemon.listener.accept().unwrap();

            thread::sleep(Duration::from_millis(200));
        });

        let verdict = client.verdict(&event(), Duration::from_millis(40));

        worker.join().unwrap();
        assert_eq!(verdict, Err(HOOK_TIMEOUT_REASON.to_owned()));
    }

    #[test]
    fn a_trickling_reply_stops_at_the_deadline() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = thread::spawn(move || {
            let (mut stream, _) = daemon.listener.accept().unwrap();
            {
                let mut reader = BufReader::new(&mut stream);
                read_line(&mut reader).unwrap().unwrap();
            }

            // Ten bytes at 20 ms intervals outlast the budget without a newline.
            for _ in 0..10 {
                let _ = stream.write_all(b"x");
                thread::sleep(Duration::from_millis(20));
            }
        });

        let verdict = client.verdict(&event(), Duration::from_millis(120));

        worker.join().unwrap();
        assert_eq!(verdict, Err(HOOK_TIMEOUT_REASON.to_owned()));
    }

    #[test]
    fn a_full_connect_backlog_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("full.sock");
        let address = SocketAddrUnix::new(&socket).unwrap();
        let listener = socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        bind(&listener, &address).unwrap();
        listen(&listener, 1).unwrap();

        let client = FramedEventBefore::new(&socket, "quiet-bots");
        let mut held = Vec::new();
        let mut backlog_full = false;

        // Fill the listener's single-slot backlog without accepting anything.
        for _ in 0..3 {
            let fd = socket_with(
                AddressFamily::UNIX,
                SocketType::STREAM,
                SocketFlags::NONBLOCK | SocketFlags::CLOEXEC,
                None,
            )
            .unwrap();
            match connect(&fd, &address) {
                Ok(()) => held.push(fd),
                Err(Errno::AGAIN | Errno::INPROGRESS) => backlog_full = true,
                Err(error) => panic!("unexpected connect error: {error}"),
            }
        }
        assert!(backlog_full, "the connect backlog never filled");

        let verdict = client.verdict(&event(), Duration::from_millis(120));

        assert_eq!(verdict, Err(HOOK_CONNECT_TIMEOUT_REASON.to_owned()));
        drop((listener, held, dir));
    }

    #[test]
    fn a_deny_without_a_reason_drops() {
        let daemon = Daemon::new();
        let client = daemon.client();
        let worker = serve(daemon.listener, |id| {
            Some(hook_reply(id, &json!({ "kind": "deny" })))
        });

        let verdict = client.verdict(&event(), BUDGET);

        worker.join().unwrap();
        assert_eq!(
            verdict,
            Ok(BeforeVerdict::Drop {
                reason: "plugin-deny:quiet-bots:invalid-reason".into(),
            })
        );
    }

    #[test]
    fn a_missing_socket_path_is_untrusted() {
        let dir = tempfile::tempdir().unwrap();
        let client =
            FramedEventBefore::new(dir.path().join("missing.sock"), "quiet-bots");

        assert_eq!(
            client.verdict(&event(), BUDGET),
            Err(HOOK_SOCKET_UNTRUSTED_REASON.to_owned())
        );
    }

    #[test]
    fn a_regular_file_socket_path_is_untrusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-socket");
        std::fs::write(&path, b"x").unwrap();
        let client = FramedEventBefore::new(path, "quiet-bots");

        assert_eq!(
            client.verdict(&event(), BUDGET),
            Err(HOOK_SOCKET_UNTRUSTED_REASON.to_owned())
        );
    }

    #[test]
    fn a_broken_pipe_is_a_named_write_error() {
        let (mut client, peer) = UnixStream::pair().unwrap();
        peer.shutdown(Shutdown::Read).unwrap();
        let frame = b"{\"kind\":\"hook\"}\n";
        let deadline = Instant::now()
            .checked_add(Duration::from_secs(2))
            .unwrap_or_else(Instant::now);

        assert_eq!(
            exchange_stream(&mut client, frame, deadline),
            Err(HOOK_CONNECT_REASON.to_owned())
        );
    }

    #[test]
    fn a_regular_file_and_a_missing_path_are_untrusted() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let suffix = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir();
        let regular = dir.join(format!(
            "event-before-regular-{}-{suffix}.tmp",
            std::process::id()
        ));
        let missing = dir.join(format!(
            "event-before-missing-{}-{suffix}.sock",
            std::process::id()
        ));
        std::fs::write(&regular, b"x").unwrap();

        assert_eq!(
            validate_socket(&regular),
            Err(HOOK_SOCKET_UNTRUSTED_REASON.to_owned())
        );
        assert_eq!(
            validate_socket(&missing),
            Err(HOOK_SOCKET_UNTRUSTED_REASON.to_owned())
        );

        let _ = std::fs::remove_file(&regular);
    }
}
