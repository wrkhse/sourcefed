//! A source that records each event it returns to the poll engine.

use std::sync::{Arc, Mutex, PoisonError};

use sourcefed_core::{
    Event, PollError, PollOutcome, PollRequest, Source, SourceName,
};

/// Wraps a source and keeps a copy of every event it returns from a poll.
#[derive(Debug)]
pub struct RecordingSource<S> {
    inner: S,
    recorded: Arc<Mutex<Vec<Event>>>,
}

impl<S: Source> RecordingSource<S> {
    /// Wraps a source with a recorder the caller can drain.
    #[must_use]
    pub const fn new(inner: S, recorded: Arc<Mutex<Vec<Event>>>) -> Self {
        Self { inner, recorded }
    }
}

impl<S: Source> Source for RecordingSource<S> {
    fn name(&self) -> &SourceName {
        self.inner.name()
    }

    fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError> {
        let outcome = self.inner.poll(request)?;

        self.recorded
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend(outcome.events().iter().cloned());

        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use sourcefed_core::{EventId, EventKind, EventSubject, Next, Position};

    use super::*;

    struct ScriptedSource {
        name: SourceName,
        outcome: PollOutcome,
    }

    impl Source for ScriptedSource {
        fn name(&self) -> &SourceName {
            &self.name
        }

        fn poll(&self, _request: PollRequest) -> Result<PollOutcome, PollError> {
            Ok(self.outcome.clone())
        }
    }

    #[test]
    fn a_poll_records_the_event_the_inner_source_returns() {
        let now = Timestamp::UNIX_EPOCH;
        let name = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(name.clone(), "deploy".into()).unwrap();
        let event = Event::new(
            EventId::new("e1".into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            now,
        )
        .unwrap();
        let outcome = PollOutcome::new(
            vec![event.clone()],
            Position::new("1".into()).unwrap(),
            Next::Due(now),
        )
        .unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let source = RecordingSource::new(
            ScriptedSource {
                name: name.clone(),
                outcome,
            },
            recorded.clone(),
        );

        assert_eq!(source.name(), &name);

        let polled = source
            .poll(PollRequest {
                now,
                position: None,
            })
            .unwrap();

        assert_eq!(polled.events(), std::slice::from_ref(&event));
        assert_eq!(*recorded.lock().unwrap(), vec![event]);
    }
}
