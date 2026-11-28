//! An [`EventBefore`] hook that asks tack's daemon over a framed socket.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufReader, ErrorKind, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tack_protocol::wire::{
    Outcome, PROTOCOL_VERSION, Reply, Request, ToolCall, WireError, encode_line,
    read_line,
};

use crate::event::Event;
use crate::{
    BeforeVerdict, EventBefore, HOOK_ANNOTATION_TYPE_REASON,
    HOOK_ANNOTATIONS_REASON, HOOK_CONNECT_REASON, HOOK_CONNECT_TIMEOUT_REASON,
    HOOK_DAEMON_ERROR_REASON, HOOK_DECODE_REASON, HOOK_ENCODE_REASON,
    HOOK_ID_REASON, HOOK_PEER_CLOSED_REASON, HOOK_REWRITE_REFUSED_REASON,
    HOOK_SOCKET_UNTRUSTED_REASON, HOOK_TIMEOUT_REASON, HOOK_UNKNOWN_OUTCOME_REASON,
    HOOK_VERSION_REASON,
};

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
        let mut stream = connect_bounded(&self.socket, deadline)?;

        exchange_stream(&mut stream, frame, deadline)
    }

    fn decide(&self, value: Value, id: u64) -> Result<BeforeVerdict, String> {
        verify(&value, id)?;

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
            Outcome::Deny { reason } => Ok(BeforeVerdict::Drop {
                reason: format!("plugin-deny:{}:{}", self.hook_name, reason),
            }),
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
    let left = remaining(deadline)?;
    stream
        .set_read_timeout(Some(left))
        .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

    let frame = {
        let mut reader = BufReader::new(&mut *stream);
        let read = read_line(&mut reader);
        let _ = remaining(deadline)?;

        match read {
            Ok(Some(frame)) => frame,
            Ok(None) => return Err(HOOK_PEER_CLOSED_REASON.to_owned()),
            Err(error) => return Err(wire_reason(&error, deadline)),
        }
    };

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
fn connect_bounded(path: &Path, deadline: Instant) -> Result<UnixStream, String> {
    validate_socket(path)?;

    let timeout = remaining(deadline)?;
    let owned = path.to_owned();
    let (sender, receiver) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("event-before-connect".into())
        .spawn(move || {
            let _ = sender.send(UnixStream::connect(&owned));
        })
        .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

    let stream = match receiver.recv_timeout(timeout) {
        Ok(Ok(stream)) => stream,
        Ok(Err(_)) => return Err(HOOK_CONNECT_REASON.to_owned()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(HOOK_CONNECT_TIMEOUT_REASON.to_owned());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(HOOK_CONNECT_REASON.to_owned());
        }
    };
    let _ = worker.join();

    Ok(stream)
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

fn wire_reason(error: &WireError, deadline: Instant) -> String {
    match error {
        WireError::Malformed | WireError::TooLarge => HOOK_DECODE_REASON.to_owned(),
        WireError::Closed => HOOK_PEER_CLOSED_REASON.to_owned(),
        WireError::Io if remaining(deadline).is_err() => {
            HOOK_TIMEOUT_REASON.to_owned()
        }
        WireError::Io => HOOK_CONNECT_REASON.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Shutdown;

    use super::*;

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
