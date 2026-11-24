use std::fmt;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::{Event, ModelError, Position, validate_text};

const MAX_SOURCE_NAME_LEN: usize = 64;
/// Maximum number of events in one [`PollOutcome`].
pub const MAX_EVENTS_PER_POLL: usize = 100;

/// Names a source, such as `timer`: lowercase ASCII segments joined by hyphens.
///
/// It starts every derived [`EventId`](crate::EventId) and displays as its
/// text. Deserializing applies the same checks as [`SourceName::new`].
#[derive(
    Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(try_from = "String", into = "String")]
pub struct SourceName(String);

impl SourceName {
    /// Wraps `value` after checking its length and characters.
    ///
    /// # Errors
    ///
    /// Returns an error unless the name has 1 to 64 ASCII bytes and consists
    /// of lowercase alphanumeric segments separated by single hyphens.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "source name", MAX_SOURCE_NAME_LEN)?;

        let valid = value.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });

        if !valid {
            return Err(ModelError::Invalid {
                field: "source name",
                reason: "must use lowercase ascii alphanumeric segments",
            });
        }

        Ok(Self(value))
    }

    /// Returns the name's text.
    #[must_use]
    pub const fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl TryFrom<String> for SourceName {
    type Error = ModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<SourceName> for String {
    fn from(name: SourceName) -> Self {
        name.0
    }
}

impl fmt::Display for SourceName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// What a source receives for one poll.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PollRequest {
    /// The current time as the engine reads it for this poll.
    pub now: Timestamp,
    /// The position the last poll returned, or `None` on the first poll.
    pub position: Option<Position>,
}

/// What a source returns from a poll that succeeds: the new events, the
/// position to save, and the next step.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PollOutcome {
    events: Vec<Event>,
    position: Position,
    next: Next,
}

impl PollOutcome {
    /// Builds an outcome with at most [`MAX_EVENTS_PER_POLL`] events.
    ///
    /// # Errors
    ///
    /// Returns an error if the event count exceeds [`MAX_EVENTS_PER_POLL`].
    pub fn new(
        events: Vec<Event>,
        position: Position,
        next: Next,
    ) -> Result<Self, ModelError> {
        if events.len() > MAX_EVENTS_PER_POLL {
            return Err(ModelError::TooMany {
                field: "poll outcome events",
                limit: MAX_EVENTS_PER_POLL,
            });
        }

        Ok(Self {
            events,
            position,
            next,
        })
    }

    /// Returns the events this poll found, at most [`MAX_EVENTS_PER_POLL`].
    #[must_use]
    pub const fn events(&self) -> &[Event] {
        self.events.as_slice()
    }

    /// Returns the position to save and pass to the next poll.
    #[must_use]
    pub const fn position(&self) -> &Position {
        &self.position
    }

    /// Returns what the engine does after this poll.
    #[must_use]
    pub const fn next(&self) -> Next {
        self.next
    }
}

/// What the engine does with a source after a poll.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Next {
    /// Poll the source again at the given time.
    Due(Timestamp),
    /// The source has finished: the engine stops polling it and the monitor
    /// ends.
    Done,
}

/// Why a poll fails.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PollError {
    /// The source could not complete the poll; `message` says why.
    #[error("source {source_name} poll failed: {message}")]
    Failed {
        source_name: SourceName,
        message: String,
    },
}

/// The contract every source implements: a fixed name and a poll that resumes
/// from a saved position.
///
/// Sources are shared across threads, so each one is `Send` and `Sync`.
pub trait Source: Send + Sync {
    /// Returns the source's name, which stays the same between calls.
    fn name(&self) -> &SourceName;

    /// Reads what happened since `request.position` and returns the new
    /// events, the position to save, and the next step.
    ///
    /// # Errors
    ///
    /// Returns a source-specific failure when the poll cannot complete.
    fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError>;
}

#[cfg(test)]
mod tests {
    use proptest::{prop_assert_eq, prop_oneof, proptest};
    use serde_json::error::Category;

    use super::*;
    use crate::{EventId, EventKind, EventSubject, bounded_text};

    struct FakeSource {
        name: SourceName,
        outcome: PollOutcome,
    }

    impl Source for FakeSource {
        fn name(&self) -> &SourceName {
            &self.name
        }

        fn poll(&self, _request: PollRequest) -> Result<PollOutcome, PollError> {
            Ok(self.outcome.clone())
        }
    }

    #[test]
    fn source_names_accept_lowercase_segments_and_length_boundaries() {
        for value in [
            "a".into(),
            "timer-2".into(),
            "x".repeat(MAX_SOURCE_NAME_LEN),
        ] {
            assert_eq!(SourceName::new(value.clone()).unwrap().as_str(), value);
        }
    }

    #[test]
    fn source_names_reject_invalid_segments() {
        for value in ["Timer", "timer_1", "é", "-timer", "timer-", "timer--one"] {
            assert_eq!(
                SourceName::new(value.into()),
                Err(ModelError::Invalid {
                    field: "source name",
                    reason: "must use lowercase ascii alphanumeric segments",
                })
            );
        }
    }

    #[test]
    fn source_names_reject_empty_and_oversized_values() {
        assert_eq!(
            SourceName::new(String::new()),
            Err(ModelError::Empty {
                field: "source name"
            })
        );
        assert_eq!(
            SourceName::new("x".repeat(MAX_SOURCE_NAME_LEN + 1)),
            Err(ModelError::TooLong {
                field: "source name",
                limit: MAX_SOURCE_NAME_LEN,
            })
        );
    }

    #[test]
    fn json_source_names_are_validated() {
        for (json, expected) in [
            (r#""""#.to_owned(), "source name is empty"),
            (
                r#""Timer""#.to_owned(),
                "source name must use lowercase ascii alphanumeric segments",
            ),
            (
                serde_json::to_string(&"x".repeat(MAX_SOURCE_NAME_LEN + 1)).unwrap(),
                "source name exceeds 64 bytes",
            ),
        ] {
            let error = serde_json::from_str::<SourceName>(&json).unwrap_err();

            assert_eq!(error.classify(), Category::Data);
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn source_poll_accepts_the_event_limit_but_no_more() {
        let name = SourceName::new("timer".into()).unwrap();
        let position = Position::new("cursor".into()).unwrap();
        let now = "2026-01-01T00:00:00Z".parse().unwrap();
        let due = "2026-01-01T00:01:00Z".parse().unwrap();
        let id = EventId::new("deploy".into()).unwrap();
        let kind = EventKind::TimerFired;
        let subject = EventSubject::new(name.clone(), "deploy".into()).unwrap();
        let event = Event::new(id, kind, subject, "deploy".into(), now).unwrap();
        let events = vec![event.clone(); MAX_EVENTS_PER_POLL];
        let outcome = PollOutcome::new(events, position.clone(), Next::Due(due));
        let source: Box<dyn Source> = Box::new(FakeSource {
            name,
            outcome: outcome.unwrap(),
        });

        let polled = source
            .poll(PollRequest {
                now,
                position: None,
            })
            .unwrap();
        let oversized = vec![event; MAX_EVENTS_PER_POLL + 1];

        assert_eq!(polled.events().len(), MAX_EVENTS_PER_POLL);
        assert_eq!(polled.position(), &position);
        assert_eq!(polled.next(), Next::Due(due));
        assert_eq!(
            PollOutcome::new(oversized, position, Next::Done).unwrap_err(),
            ModelError::TooMany {
                field: "poll outcome events",
                limit: MAX_EVENTS_PER_POLL,
            }
        );
    }

    proptest! {
        #[test]
        fn accepted_source_names_preserve_the_input(input in prop_oneof![
            bounded_text(),
            "([a-z0-9]{1,8}-){0,6}[a-z0-9]{1,8}",
        ]) {
            if let Ok(value) = SourceName::new(input.clone()) {
                let len = value.as_str().len();

                prop_assert_eq!(value.as_str().as_bytes(), input.as_bytes());
                prop_assert_eq!(len, len.min(MAX_SOURCE_NAME_LEN));
                prop_assert_eq!(String::from(value), input);
            }
        }
    }
}
