use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{ModelError, SourceName, validate_text};

const MAX_MONITOR_ID_LEN: usize = 128;

/// Names one monitor: 1 to 128 ASCII letters, digits, hyphens or underscores.
///
/// Deserializing applies the same checks as [`MonitorId::new`].
#[derive(
    Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(try_from = "String", into = "String")]
pub struct MonitorId(String);

impl MonitorId {
    /// Wraps `value` after checking its length and characters.
    ///
    /// # Errors
    ///
    /// Returns an error unless the ID has 1 to 128 ASCII bytes made up of
    /// letters, digits, hyphens, or underscores.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "monitor id", MAX_MONITOR_ID_LEN)?;

        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(ModelError::Invalid {
                field: "monitor id",
                reason: "must use ascii alphanumerics, hyphens, or underscores",
            });
        }

        Ok(Self(value))
    }

    /// Returns the ID's text.
    #[must_use]
    pub const fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl TryFrom<String> for MonitorId {
    type Error = ModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<MonitorId> for String {
    fn from(id: MonitorId) -> Self {
        id.0
    }
}

/// How often a monitor polls, in whole seconds from 1 to 3600.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PollInterval(Duration);

impl PollInterval {
    /// Builds an interval of `secs` seconds.
    ///
    /// # Errors
    ///
    /// Returns an error unless the interval is from 1 to 3600 seconds.
    pub const fn from_secs(secs: u64) -> Result<Self, ModelError> {
        if secs == 0 || secs > 3600 {
            return Err(ModelError::Invalid {
                field: "poll interval",
                reason: "must be between 1 and 3600 seconds",
            });
        }

        Ok(Self(Duration::from_secs(secs)))
    }

    /// Returns the interval in whole seconds.
    #[must_use]
    pub const fn as_secs(&self) -> u64 {
        self.0.as_secs()
    }
}

/// What a monitor watches and how often it polls.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonitorConfig {
    /// Names this monitor.
    pub id: MonitorId,
    /// The source this monitor polls.
    pub source: SourceName,
    /// The time between polls.
    pub poll_interval: PollInterval,
}

/// Where a monitor is in its life.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonitorStatus {
    /// The monitor polls its source.
    Running,
    /// A user stopped the monitor, and it does not poll.
    Stopped,
    /// The source returned [`Next::Done`](crate::Next::Done), and the monitor
    /// does not poll.
    Ended,
}

#[cfg(test)]
mod tests {
    use proptest::{prop_assert_eq, prop_oneof, proptest};
    use serde_json::error::Category;

    use super::*;
    use crate::bounded_text;

    #[test]
    fn monitor_ids_accept_ascii_ids_and_length_boundaries() {
        for value in ["x".into(), "A-1_2".into(), "x".repeat(MAX_MONITOR_ID_LEN)] {
            assert_eq!(MonitorId::new(value.clone()).unwrap().as_str(), value);
        }
    }

    #[test]
    fn monitor_ids_reject_empty_oversized_and_invalid_values() {
        assert_eq!(
            MonitorId::new(String::new()),
            Err(ModelError::Empty {
                field: "monitor id"
            })
        );
        assert_eq!(
            MonitorId::new("x".repeat(MAX_MONITOR_ID_LEN + 1)),
            Err(ModelError::TooLong {
                field: "monitor id",
                limit: MAX_MONITOR_ID_LEN,
            })
        );

        for value in ["with a space", "a.b", "é"] {
            assert_eq!(
                MonitorId::new(value.into()),
                Err(ModelError::Invalid {
                    field: "monitor id",
                    reason: "must use ascii alphanumerics, hyphens, or underscores",
                })
            );
        }
    }

    #[test]
    fn json_monitor_ids_are_validated() {
        for (json, expected) in [
            (r#""""#.to_owned(), "monitor id is empty"),
            (
                r#""a.b""#.to_owned(),
                "monitor id must use ascii alphanumerics, hyphens, or underscores",
            ),
            (
                serde_json::to_string(&"x".repeat(MAX_MONITOR_ID_LEN + 1)).unwrap(),
                "monitor id exceeds 128 bytes",
            ),
        ] {
            let error = serde_json::from_str::<MonitorId>(&json).unwrap_err();

            assert_eq!(error.classify(), Category::Data);
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn poll_interval_accepts_one_second_and_one_hour() {
        assert_eq!(PollInterval::from_secs(1).unwrap().as_secs(), 1);
        assert_eq!(PollInterval::from_secs(3600).unwrap().as_secs(), 3600);
    }

    #[test]
    fn poll_interval_rejects_values_outside_the_range() {
        for secs in [0, 3601] {
            assert_eq!(
                PollInterval::from_secs(secs),
                Err(ModelError::Invalid {
                    field: "poll interval",
                    reason: "must be between 1 and 3600 seconds",
                })
            );
        }
    }

    proptest! {
        #[test]
        fn accepted_monitor_ids_preserve_the_input(input in prop_oneof![
            bounded_text(),
            "[A-Za-z0-9_-]{1,128}",
        ]) {
            if let Ok(value) = MonitorId::new(input.clone()) {
                let len = value.as_str().len();

                prop_assert_eq!(value.as_str().as_bytes(), input.as_bytes());
                prop_assert_eq!(len, len.min(MAX_MONITOR_ID_LEN));
                prop_assert_eq!(String::from(value), input);
            }
        }
    }
}
