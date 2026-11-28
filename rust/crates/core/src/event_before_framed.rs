//! An [`EventBefore`] hook that asks tack's daemon over a framed socket.

use std::collections::BTreeMap;
use std::io::{BufReader, Write};
use std::os::unix::net::{SocketAddr, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tack_protocol::wire::{
    Outcome, PROTOCOL_VERSION, Reply, Request, ToolCall, WireError, encode_line,
    read_line,
};

use crate::event::Event;
use crate::{
    BeforeVerdict, EventBefore, HOOK_ANNOTATIONS_REASON, HOOK_CONNECT_REASON,
    HOOK_DAEMON_ERROR_REASON, HOOK_DECODE_REASON, HOOK_ID_REASON,
    HOOK_PEER_CLOSED_REASON, HOOK_REWRITE_REFUSED_REASON,
    HOOK_UNKNOWN_OUTCOME_REASON, HOOK_VERSION_REASON,
};

/// Asks one named `eventBefore` hook for a verdict over one Unix socket.
///
/// Each call opens a new connection and bounds it by the trait's budget. Every
/// failed exchange keeps the event with a named reason.
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
        let (id, frame) = self.request(event)?;
        let reply = self.exchange(&frame, budget)?;

        self.decide(reply, id)
    }

    fn request(&self, event: &Event) -> Result<(u64, Vec<u8>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let input = serde_json::to_value(event)
            .map_err(|_| HOOK_DECODE_REASON.to_owned())?;
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
        let frame = encode_line(&request).map_err(wire_reason)?;

        Ok((id, frame))
    }

    fn exchange(&self, frame: &[u8], budget: Duration) -> Result<Value, String> {
        let address = SocketAddr::from_pathname(&self.socket)
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;
        let mut stream = UnixStream::connect_timeout(&address, budget)
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;
        stream
            .set_read_timeout(Some(budget))
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;
        stream
            .set_write_timeout(Some(budget))
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;
        stream
            .write_all(frame)
            .map_err(|_| HOOK_CONNECT_REASON.to_owned())?;

        let reply = {
            let mut reader = BufReader::new(stream);

            match read_line(&mut reader) {
                Ok(Some(frame)) => frame,
                Ok(None) => return Err(HOOK_PEER_CLOSED_REASON.to_owned()),
                Err(error) => return Err(wire_reason(error)),
            }
        };
        let value: Value = serde_json::from_slice(&reply)
            .map_err(|_| HOOK_DECODE_REASON.to_owned())?;

        match value.get("kind").and_then(Value::as_str) {
            Some("hook") => {}
            Some("error") => return Err(HOOK_DAEMON_ERROR_REASON.to_owned()),
            Some("tool") => return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned()),
            _ => return Err(HOOK_DECODE_REASON.to_owned()),
        }

        Ok(value)
    }

    fn decide(&self, value: Value, id: u64) -> Result<BeforeVerdict, String> {
        let outcome_kind = value
            .get("outcome")
            .and_then(|outcome| outcome.get("kind"))
            .and_then(Value::as_str);

        if !matches!(
            outcome_kind,
            Some("allow" | "deny" | "rewrite" | "annotate" | "drop")
        ) {
            return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned());
        }

        let reply: Reply = serde_json::from_value(value)
            .map_err(|_| HOOK_DECODE_REASON.to_owned())?;
        let Reply::Hook {
            id: reply_id,
            version,
            outcome,
        } = reply
        else {
            return Err(HOOK_UNKNOWN_OUTCOME_REASON.to_owned());
        };

        if reply_id != id {
            return Err(HOOK_ID_REASON.to_owned());
        }
        if version != PROTOCOL_VERSION {
            return Err(HOOK_VERSION_REASON.to_owned());
        }

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

fn wire_reason(error: WireError) -> String {
    match error {
        WireError::Malformed | WireError::TooLarge => HOOK_DECODE_REASON.to_owned(),
        WireError::Closed => HOOK_PEER_CLOSED_REASON.to_owned(),
        WireError::Io => HOOK_CONNECT_REASON.to_owned(),
    }
}

fn annotation_fields(
    fields: serde_json::Map<String, Value>,
) -> Result<BTreeMap<String, String>, String> {
    let fields: BTreeMap<String, String> = fields
        .into_iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };

            (key, text)
        })
        .collect();

    Event::validate_annotations(&fields)
        .map_err(|_| HOOK_ANNOTATIONS_REASON.to_owned())?;

    Ok(fields)
}
