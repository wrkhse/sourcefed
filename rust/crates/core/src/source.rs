use std::fmt;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::{Event, ModelError, Position, validate_text};

const MAX_SOURCE_NAME_LEN: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceName(String);

impl SourceName {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PollRequest {
    pub now: Timestamp,
    pub position: Option<Position>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PollOutcome {
    pub events: Vec<Event>,
    pub position: Position,
    pub next_due: Timestamp,
    pub terminal: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PollError {
    #[error("source {source_name} poll failed: {message}")]
    Failed {
        source_name: SourceName,
        message: String,
    },
}

pub trait Source: Send + Sync {
    fn name(&self) -> &SourceName;

    /// # Errors
    ///
    /// Returns a source-specific failure when the poll cannot complete.
    fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError>;
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
