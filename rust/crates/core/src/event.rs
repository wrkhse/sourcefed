use std::hash::{Hash, Hasher};

use jiff::Timestamp;
use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{MAX_ID_LEN, MAX_SUMMARY_LEN, ModelError, SourceName, validate_text};

/// Identifies one event: 1 to [`MAX_ID_LEN`] bytes with no control characters.
///
/// Two events with the same ID are the same event. Deserializing applies the
/// same checks as [`EventId::new`].
#[derive(
    Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(try_from = "String", into = "String")]
pub struct EventId(String);

impl EventId {
    /// Wraps `value` after checking its length and characters.
    ///
    /// # Errors
    ///
    /// Returns an error for empty, oversized, or control-containing IDs.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "event id", MAX_ID_LEN)?;

        Ok(Self(value))
    }

    /// Builds a stable ID as `<source>:<key>:<at>`, with the timestamp in UTC.
    ///
    /// # Errors
    ///
    /// Returns an error if the key contains a colon or the resulting ID exceeds
    /// the byte limit or contains a control character.
    pub fn derive(
        source: &SourceName,
        key: &str,
        at: Timestamp,
    ) -> Result<Self, ModelError> {
        if key.contains(':') {
            return Err(ModelError::Invalid {
                field: "event key",
                reason: "must not contain a colon",
            });
        }

        Self::new(format!("{source}:{key}:{at}"))
    }

    /// Returns the ID's text.
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

/// What happened, serialized by its dotted wire name such as `timer.fired`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EventKind {
    /// A timer reached its due time.
    #[serde(rename = "timer.fired")]
    TimerFired,
}

impl EventKind {
    /// Returns the wire name, the same text serde writes.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TimerFired => "timer.fired",
        }
    }
}

/// What an event is about: its source and a key within that source.
///
/// The key holds 1 to [`MAX_ID_LEN`] bytes with no control characters, and
/// deserializing applies the same checks.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EventSubject {
    source: SourceName,
    #[serde(deserialize_with = "deserialize_key")]
    key: String,
}

impl EventSubject {
    /// Pairs `source` with `key` after checking the key.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty, oversized, or control-containing key.
    pub fn new(source: SourceName, key: String) -> Result<Self, ModelError> {
        Ok(Self {
            source,
            key: validate_key(key)?,
        })
    }

    /// Returns the source the key belongs to.
    #[must_use]
    pub const fn source(&self) -> &SourceName {
        &self.source
    }

    /// Returns the key that names the subject within its source.
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

/// One change a source reports, such as a timer firing.
///
/// Events compare and hash by ID alone, regardless of their other fields, so
/// two events with the same ID count as one.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    id: EventId,
    kind: EventKind,
    subject: EventSubject,
    #[serde(deserialize_with = "deserialize_summary")]
    summary: String,
    at: Timestamp,
}

impl PartialEq for Event {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for Event {}

impl Hash for Event {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

impl Event {
    /// Builds an event whose summary holds 1 to [`MAX_SUMMARY_LEN`] bytes.
    ///
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

    /// Returns the ID that gives the event its identity.
    #[must_use]
    pub const fn id(&self) -> &EventId {
        &self.id
    }

    /// Returns what happened.
    #[must_use]
    pub const fn kind(&self) -> EventKind {
        self.kind
    }

    /// Returns what the event is about.
    #[must_use]
    pub const fn subject(&self) -> &EventSubject {
        &self.subject
    }

    /// Returns the one-line text that describes the event.
    #[must_use]
    pub const fn summary(&self) -> &str {
        self.summary.as_str()
    }

    /// Returns the instant the event happened.
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
    use std::collections::{HashSet, hash_map::DefaultHasher};
    use std::hash::{Hash, Hasher};

    use proptest::{prop_assert_eq, proptest};
    use serde_json::error::Category;

    use super::*;
    use crate::bounded_text;

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
        for (json, expected) in [
            (r#""""#.to_owned(), "event id is empty"),
            (
                r#""\n""#.to_owned(),
                "event id contains a control character",
            ),
            (
                serde_json::to_string(&"x".repeat(MAX_ID_LEN + 1)).unwrap(),
                "event id exceeds 256 bytes",
            ),
        ] {
            let error = serde_json::from_str::<EventId>(&json).unwrap_err();

            assert_eq!(error.classify(), Category::Data);
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn derived_event_ids_are_stable_and_distinguish_inputs() {
        let source = SourceName::new("timer".into()).unwrap();
        let other_source = SourceName::new("other".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let later = "2026-01-01T00:00:00.000000001Z".parse().unwrap();
        let id = EventId::derive(&source, "deploy", at).unwrap();
        let duplicate = EventId::derive(&source, "deploy", at).unwrap();

        assert_eq!(id.as_str(), "timer:deploy:2026-01-01T00:00:00Z");
        assert_eq!(id, duplicate);

        for other in [
            EventId::derive(&other_source, "deploy", at).unwrap(),
            EventId::derive(&source, "other", at).unwrap(),
            EventId::derive(&source, "deploy", later).unwrap(),
        ] {
            assert_ne!(id, other);
        }

        let ids = HashSet::from([id.clone(), duplicate]);

        assert_eq!(ids, HashSet::from([id]));
    }

    #[test]
    fn derived_event_ids_reject_ambiguous_keys() {
        let source = SourceName::new("timer".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();

        assert_eq!(
            EventId::derive(&source, "deploy:one", at),
            Err(ModelError::Invalid {
                field: "event key",
                reason: "must not contain a colon",
            })
        );
    }

    #[test]
    fn event_kind_uses_its_wire_name() {
        let kind = EventKind::TimerFired;
        let json = r#""timer.fired""#;

        assert_eq!(kind.as_str(), "timer.fired");
        assert_eq!(serde_json::to_string(&kind).unwrap(), json);
        assert_eq!(serde_json::from_str::<EventKind>(json).unwrap(), kind);
    }

    #[test]
    fn events_compare_and_hash_by_id() {
        let id = EventId::new("deploy-1".into()).unwrap();
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let kind = EventKind::TimerFired;
        let other_id = EventId::new("deploy-2".into()).unwrap();
        let make_event = |id, summary: &str| {
            let subject = subject.clone();

            Event::new(id, kind, subject, summary.into(), at).unwrap()
        };

        let event = make_event(id.clone(), "one");
        let duplicate = make_event(id, "two");
        let other = make_event(other_id, "one");

        assert_eq!(event, duplicate);
        assert_ne!(event, other);

        let hash_of = |event: &Event| {
            let mut hasher = DefaultHasher::new();
            event.hash(&mut hasher);

            hasher.finish()
        };

        assert_ne!(hash_of(&event), hash_of(&other));

        let events = HashSet::from([event.clone(), duplicate, other.clone()]);

        assert_eq!(events, HashSet::from([event, other]));
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

        let decoded = serde_json::from_str::<Event>(json).unwrap();

        assert_eq!(decoded.id().as_str(), "deploy-1");
        assert_eq!(decoded.kind(), EventKind::TimerFired);
        assert_eq!(decoded.subject().source().as_str(), "timer");
        assert_eq!(decoded.subject().key(), "deploy");
        assert_eq!(decoded.summary(), "deploy");
        assert_eq!(decoded.at(), at);
    }

    #[test]
    fn subject_keys_and_event_summaries_are_validated() {
        let source = SourceName::new("timer".into()).unwrap();
        let json = r#"{"source":"timer","key":""}"#;
        let error = serde_json::from_str::<EventSubject>(json).unwrap_err();

        assert_eq!(
            EventSubject::new(source.clone(), String::new()),
            Err(ModelError::Empty {
                field: "subject key",
            })
        );
        assert_eq!(error.classify(), Category::Data);
        assert_eq!(
            error.to_string(),
            "subject key is empty at line 1 column 27"
        );

        let id = EventId::new("deploy-1".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let oversized = "x".repeat(MAX_SUMMARY_LEN + 1);
        let json = concat!(
            r#"{"id":"deploy-1","kind":"timer.fired","#,
            r#""subject":{"source":"timer","key":"deploy"},"#,
            r#""summary":"","at":"2026-01-01T00:00:00Z"}"#,
        );
        let error = serde_json::from_str::<Event>(json).unwrap_err();

        assert_eq!(
            Event::new(id, EventKind::TimerFired, subject, oversized, at),
            Err(ModelError::TooLong {
                field: "summary",
                limit: MAX_SUMMARY_LEN,
            })
        );
        assert_eq!(error.classify(), Category::Data);
        assert_eq!(error.to_string(), "summary is empty at line 1 column 94");
    }

    proptest! {
        #[test]
        fn accepted_event_ids_preserve_the_input(input in bounded_text()) {
            if let Ok(value) = EventId::new(input.clone()) {
                let len = value.as_str().len();

                prop_assert_eq!(value.as_str().as_bytes(), input.as_bytes());
                prop_assert_eq!(len, len.min(MAX_ID_LEN));
                prop_assert_eq!(String::from(value), input);
            }
        }
    }
}
