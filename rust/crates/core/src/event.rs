use jiff::Timestamp;
use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{MAX_ID_LEN, MAX_SUMMARY_LEN, ModelError, SourceName, validate_text};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct EventId(String);

impl EventId {
    /// # Errors
    ///
    /// Returns an error for empty, oversized, or control-containing IDs.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "event id", MAX_ID_LEN)?;

        Ok(Self(value))
    }

    #[must_use]
    pub const fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl TryFrom<String> for EventId {
    type Error = ModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<EventId> for String {
    fn from(id: EventId) -> Self {
        id.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EventKind {
    #[serde(rename = "timer.fired")]
    TimerFired,
    #[serde(rename = "timer.missed")]
    TimerMissed,
    #[serde(rename = "overflow")]
    Overflow,
}

impl EventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TimerFired => "timer.fired",
            Self::TimerMissed => "timer.missed",
            Self::Overflow => "overflow",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EventSubject {
    source: SourceName,
    #[serde(deserialize_with = "deserialize_key")]
    key: String,
}

impl EventSubject {
    /// # Errors
    ///
    /// Returns an error for an empty, oversized, or control-containing key.
    pub fn new(source: SourceName, key: String) -> Result<Self, ModelError> {
        Ok(Self {
            source,
            key: validate_key(key)?,
        })
    }

    #[must_use]
    pub const fn source(&self) -> &SourceName {
        &self.source
    }

    #[must_use]
    pub const fn key(&self) -> &str {
        self.key.as_str()
    }
}

fn validate_key(key: String) -> Result<String, ModelError> {
    validate_text(&key, "subject key", MAX_ID_LEN)?;

    Ok(key)
}

fn deserialize_key<'de, D: Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    validate_key(String::deserialize(de)?).map_err(de::Error::custom)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Event {
    id: EventId,
    kind: EventKind,
    subject: EventSubject,
    #[serde(deserialize_with = "deserialize_summary")]
    summary: String,
    at: Timestamp,
}

impl Event {
    /// # Errors
    ///
    /// Returns an error for an empty, oversized, or control-containing summary.
    pub fn new(
        id: EventId,
        kind: EventKind,
        subject: EventSubject,
        summary: String,
        at: Timestamp,
    ) -> Result<Self, ModelError> {
        Ok(Self {
            id,
            kind,
            subject,
            summary: validate_summary(summary)?,
            at,
        })
    }

    #[must_use]
    pub const fn id(&self) -> &EventId {
        &self.id
    }

    #[must_use]
    pub const fn kind(&self) -> EventKind {
        self.kind
    }

    #[must_use]
    pub const fn subject(&self) -> &EventSubject {
        &self.subject
    }

    #[must_use]
    pub const fn summary(&self) -> &str {
        self.summary.as_str()
    }

    #[must_use]
    pub const fn at(&self) -> Timestamp {
        self.at
    }
}

fn validate_summary(summary: String) -> Result<String, ModelError> {
    validate_text(&summary, "summary", MAX_SUMMARY_LEN)?;

    Ok(summary)
}

fn deserialize_summary<'de, D>(de: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    validate_summary(String::deserialize(de)?).map_err(de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_id_accepts_one_byte_and_the_maximum() {
        for value in ["x".to_owned(), "🦀".repeat(MAX_ID_LEN / 4)] {
            assert_eq!(EventId::new(value.clone()).unwrap().as_str(), value);
        }
    }

    #[test]
    fn event_id_rejects_empty_oversized_and_control_containing_ids() {
        assert_eq!(
            EventId::new(String::new()),
            Err(ModelError::Empty { field: "event id" })
        );
        assert_eq!(
            EventId::new(format!("{}x", "🦀".repeat(MAX_ID_LEN / 4))),
            Err(ModelError::TooLong {
                field: "event id",
                limit: MAX_ID_LEN,
            })
        );
        assert_eq!(
            EventId::new("x\n".into()),
            Err(ModelError::Invalid {
                field: "event id",
                reason: "contains a control character",
            })
        );
    }

    #[test]
    fn json_event_ids_are_validated() {
        for value in [String::new(), "\n".into(), "x".repeat(MAX_ID_LEN + 1)] {
            let json = serde_json::to_string(&value).unwrap();

            assert_eq!(serde_json::from_str::<EventId>(&json).ok(), None);
        }
    }

    #[test]
    fn event_kinds_use_their_wire_names() {
        for (kind, wire) in [
            (EventKind::TimerFired, "timer.fired"),
            (EventKind::TimerMissed, "timer.missed"),
            (EventKind::Overflow, "overflow"),
        ] {
            let json = format!("\"{wire}\"");

            assert_eq!(kind.as_str(), wire);
            assert_eq!(serde_json::to_string(&kind).unwrap(), json);
            assert_eq!(serde_json::from_str::<EventKind>(&json).unwrap(), kind);
        }
    }

    #[test]
    fn event_json_has_the_exact_wire_shape() {
        let id = EventId::new("deploy-1".into()).unwrap();
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let kind = EventKind::TimerFired;
        let event = Event::new(id, kind, subject, "deploy".into(), at).unwrap();
        let json = concat!(
            r#"{"id":"deploy-1","kind":"timer.fired","#,
            r#""subject":{"source":"timer","key":"deploy"},"#,
            r#""summary":"deploy","at":"2026-01-01T00:00:00Z"}"#,
        );

        assert_eq!(serde_json::to_string(&event).unwrap(), json);
        assert_eq!(serde_json::from_str::<Event>(json).unwrap(), event);
    }

    #[test]
    fn subject_keys_and_event_summaries_are_validated() {
        let source = SourceName::new("timer".into()).unwrap();
        let json = r#"{"source":"timer","key":""}"#;

        assert_eq!(
            EventSubject::new(source.clone(), String::new()),
            Err(ModelError::Empty {
                field: "subject key",
            })
        );
        assert_eq!(serde_json::from_str::<EventSubject>(json).ok(), None);

        let id = EventId::new("deploy-1".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let oversized = "x".repeat(MAX_SUMMARY_LEN + 1);

        assert_eq!(
            Event::new(id, EventKind::TimerFired, subject, oversized, at),
            Err(ModelError::TooLong {
                field: "summary",
                limit: MAX_SUMMARY_LEN,
            })
        );
        assert_eq!(
            serde_json::from_str::<Event>(concat!(
                r#"{"id":"deploy-1","kind":"timer.fired","#,
                r#""subject":{"source":"timer","key":"deploy"},"#,
                r#""summary":"","at":"2026-01-01T00:00:00Z"}"#,
            ))
            .ok(),
            None
        );
    }
}
