use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{ModelError, SourceName, validate_text};

const MAX_MONITOR_ID_LEN: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct MonitorId(String);

impl MonitorId {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PollInterval(Duration);

impl PollInterval {
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

    #[must_use]
    pub const fn as_secs(&self) -> u64 {
        self.0.as_secs()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonitorConfig {
    pub id: MonitorId,
    pub source: SourceName,
    pub poll_interval: PollInterval,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonitorStatus {
    Running,
    Stopped,
    Ended,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
