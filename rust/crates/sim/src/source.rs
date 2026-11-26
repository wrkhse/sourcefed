//! A source that records each event and poll attempt it delegates.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use sourcefed_core::{
    Event, PollError, PollOutcome, PollRequest, Source, SourceName,
};

/// A shared count of the polls delegated to a recorded source.
#[derive(Clone, Debug, Default)]
pub struct PollCounter(Arc<AtomicUsize>);

impl PollCounter {
    /// Returns how many polls the source has attempted.
    #[must_use]
    pub fn poll_count(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}

/// Wraps a source and keeps a copy of every event it returns from a poll.
#[derive(Debug)]
pub struct RecordingSource<S> {
    inner: S,
    recorded: Arc<Mutex<Vec<Event>>>,
    counter: PollCounter,
}

impl<S: Source> RecordingSource<S> {
    /// Wraps a source with a recorder the caller can drain.
    #[must_use]
    pub fn new(inner: S, recorded: Arc<Mutex<Vec<Event>>>) -> Self {
        Self {
            inner,
            recorded,
            counter: PollCounter(Arc::new(AtomicUsize::new(0))),
        }
    }

    /// Returns a shared handle the caller can read after the source moves.
    #[must_use]
    pub fn poll_counter(&self) -> PollCounter {
        self.counter.clone()
    }
}

impl<S: Source> Source for RecordingSource<S> {
    fn name(&self) -> &SourceName {
        self.inner.name()
    }

    fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError> {
        self.counter.0.fetch_add(1, Ordering::Relaxed);

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

    struct FailingSource {
        name: SourceName,
    }

    impl Source for FailingSource {
        fn name(&self) -> &SourceName {
            &self.name
        }

        fn poll(&self, _request: PollRequest) -> Result<PollOutcome, PollError> {
            Err(PollError::Failed {
                source_name: self.name.clone(),
                message: "failed".into(),
            })
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

    #[test]
    fn each_delegated_poll_increases_the_shared_count() {
        let now = Timestamp::UNIX_EPOCH;
        let name = SourceName::new("timer".into()).unwrap();
        let outcome = PollOutcome::new(
            Vec::new(),
            Position::new("1".into()).unwrap(),
            sourcefed_core::Next::Due(now),
        )
        .unwrap();
        let source = RecordingSource::new(
            ScriptedSource { name, outcome },
            Arc::new(Mutex::new(Vec::new())),
        );
        let counter = source.poll_counter();
        let request = PollRequest {
            now,
            position: None,
        };

        assert_eq!(counter.poll_count(), 0);

        source.poll(request.clone()).unwrap();
        source.poll(request).unwrap();

        assert_eq!(counter.poll_count(), 2);
    }

    #[test]
    fn a_failed_poll_still_increases_the_shared_count() {
        let name = SourceName::new("timer".into()).unwrap();
        let source = RecordingSource::new(
            FailingSource { name },
            Arc::new(Mutex::new(Vec::new())),
        );
        let counter = source.poll_counter();
        let request = PollRequest {
            now: Timestamp::UNIX_EPOCH,
            position: None,
        };

        assert!(source.poll(request).is_err());
        assert_eq!(counter.poll_count(), 1);
    }
}
