//! `sourcefed-core` holds the model and [`Source`] contract for sourcefed.
//! Each poll resumes from a [`Position`], returns a bounded batch of [`Event`]s
//! and names its next step as a [`Next`]. For each [`PositionKey`], the store
//! saves the position, remembered event IDs, and bounded pending event queue
//! together. Consumers acknowledge delivered events by key and ID without
//! changing the position or forgetting those IDs. A full pending queue
//! refuses fresh events until pending events are acknowledged.
//!
//! The crate ships one source, [`TimerSource`], which fires a named job every
//! interval. The `sourcefed-core` binary's `follow` command runs a source
//! through the poll engine, prints each normalized event as one NDJSON line,
//! and reads ack and stop lines on stdin. Each poll reads a bounded number of
//! input lines, and a line over 512 bytes is discarded with a diagnostic.
//! If it runs another 65536 bytes without a newline, the reader logs
//! `discard-bound-exceeded` and discards the remainder in bounded chunks.
//! A newline within the remainder discard's first mebibyte lets later
//! ack and stop lines reach the reader unless the discarded-line budget is
//! exhausted. The byte cap ends stdin reading with
//! `discard-total-cap-reached`. The reader also logs
//! `discard-line-budget-exhausted` and stops after discarding 64 over-long
//! lines without sending an input. A successful input send resets the count;
//! an invalid input does not.
//!
//! The store refuses version 1 files. This project is pre-production and
//! provides no migration for those files.

/// Events a source reports, with their IDs, kinds and subjects.
pub mod event;
/// The bounded pre-commit decision applied to each event.
pub mod event_before;
/// Monitors: their IDs, configuration, poll interval and status.
pub mod monitor;
/// Bounded polling and retry with durable pending events.
pub mod poll;
/// The saved place a source resumes polling from.
pub mod position;
/// The [`Source`] contract and the request and outcome of one poll.
pub mod source;
/// The sources sourcefed ships with.
pub mod sources;
/// Saved positions, remembered event IDs, and pending event queues.
pub mod store;

pub use event::{Event, EventId, EventKind, EventSubject};
pub use event_before::{
    AllowAll, BeforeVerdict, EVENT_BEFORE_TIMEOUT, EventBefore, HOOK_ERROR_REASON,
    HOOK_PANIC_REASON, HOOK_TIMEOUT_REASON,
};
pub use monitor::{MonitorConfig, MonitorId, MonitorStatus, PollInterval};
pub use poll::{
    Backoff, Clock, ClockError, DEFAULT_BACKOFF_CAP_SECS, EngineError, EngineState,
    MAX_PENDING_EVENTS, MAX_WAIT_SECS, PollEngine, StopHandle, SystemClock,
};
pub use position::Position;
pub use source::{Next, PollError, PollOutcome, PollRequest, Source, SourceName};
pub use sources::timer::TimerSource;
pub use store::{PositionKey, StateStore, Store, StoreError};

/// Maximum length in bytes of an event ID or a subject key.
pub const MAX_ID_LEN: usize = 256;
/// Maximum length in bytes of a [`Position`].
pub const MAX_POSITION_LEN: usize = 4096;
/// Maximum length in bytes of an event summary.
pub const MAX_SUMMARY_LEN: usize = 512;

/// Why a value fails validation; `field` names the value that failed.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ModelError {
    /// The value has no bytes.
    #[error("{field} is empty")]
    Empty { field: &'static str },
    /// The text exceeds `limit` bytes.
    #[error("{field} exceeds {limit} bytes")]
    TooLong { field: &'static str, limit: usize },
    /// The collection holds more than `limit` items.
    #[error("{field} exceeds {limit} items")]
    TooMany { field: &'static str, limit: usize },
    /// The value breaks the rule that `reason` states.
    #[error("{field} {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

pub(crate) fn validate_text(
    value: &str,
    field: &'static str,
    limit: usize,
) -> Result<(), ModelError> {
    if value.is_empty() {
        return Err(ModelError::Empty { field });
    }
    if value.len() > limit {
        return Err(ModelError::TooLong { field, limit });
    }
    if value.chars().any(char::is_control) {
        return Err(ModelError::Invalid {
            field,
            reason: "contains a control character",
        });
    }

    Ok(())
}

#[cfg(test)]
fn bounded_text() -> impl proptest::strategy::Strategy<Value = String> {
    use proptest::strategy::Strategy;

    r"(?s:.){0,300}".prop_map(|mut text| {
        text.truncate(text.floor_char_boundary(300));

        text
    })
}
