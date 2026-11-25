use std::fmt::Display;

use jiff::Timestamp;

use crate::source::MAX_EVENTS_PER_POLL;
use crate::{
    Event, EventId, EventKind, EventSubject, ModelError, Next, PollError,
    PollOutcome, PollRequest, Position, Source, SourceName,
};

const NANOS_PER_SEC: i128 = 1_000_000_000;
const MAX_INTERVAL_SECS: u64 = 3600;

/// Fires a named job every interval, saving the next due instant as its
/// [`Position`].
///
/// The position is that instant as an RFC 3339 UTC timestamp. The first poll,
/// with no saved position, emits nothing and saves the instant one interval
/// after the poll's time. Each later poll emits a [`EventKind::TimerFired`]
/// event for every firing due at or before the poll's time, oldest first, and
/// saves the first firing still to come. Each event's ID is
/// `timer:<job>:<due instant>`, so a source rebuilt from the same position
/// emits the same IDs.
///
/// One poll reports at most [`MAX_EVENTS_PER_POLL`] firings. When more are
/// due, the poll emits one [`EventKind::TimerMissed`] event at the first
/// missed instant whose summary gives the count and the range, and the
/// position moves past them all. A position that does not parse as a
/// timestamp, or a next instant past the largest timestamp, fails the poll.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimerSource {
    subject: EventSubject,
    interval: i128,
}

impl TimerSource {
    /// Builds a timer for `job` that fires every `every_secs` seconds, from 1
    /// to 3600. The job becomes the event subject's key and the middle of each
    /// event ID.
    ///
    /// # Errors
    ///
    /// Returns an error if the interval is zero or over 3600 seconds, or the
    /// job is empty, contains a colon or a control character, or is too long
    /// for an event ID.
    pub fn new(job: String, every_secs: u64) -> Result<Self, ModelError> {
        if every_secs == 0 {
            return Err(ModelError::Invalid {
                field: "timer interval",
                reason: "must be positive",
            });
        }

        if every_secs > MAX_INTERVAL_SECS {
            return Err(ModelError::Invalid {
                field: "timer interval",
                reason: "must be at most 3600 seconds",
            });
        }

        let name = SourceName::new("timer".into())?;
        EventId::derive(&name, &job, Timestamp::MAX)?;
        let subject = EventSubject::new(name, job)?;
        let interval = i128::from(every_secs).saturating_mul(NANOS_PER_SEC);

        Ok(Self { subject, interval })
    }

    const fn job(&self) -> &str {
        self.subject.key()
    }

    fn failed(&self, message: impl Display) -> PollError {
        PollError::Failed {
            source_name: self.subject.source().clone(),
            message: message.to_string(),
        }
    }

    fn firing(&self, first: Timestamp, index: u64) -> Result<Timestamp, PollError> {
        let offset = i128::from(index).saturating_mul(self.interval);
        let nanos = first.as_nanosecond().saturating_add(offset);

        Timestamp::from_nanosecond(nanos).map_err(|error| self.failed(error))
    }

    fn event(
        &self,
        kind: EventKind,
        at: Timestamp,
        summary: String,
    ) -> Result<Event, PollError> {
        let source = self.subject.source();
        let id = EventId::derive(source, self.job(), at)
            .map_err(|error| self.failed(error))?;

        Event::new(id, kind, self.subject.clone(), summary, at)
            .map_err(|error| self.failed(error))
    }

    fn fired(&self, first: Timestamp, count: u64) -> Result<Vec<Event>, PollError> {
        (0..count)
            .map(|index| {
                let at = self.firing(first, index)?;
                let summary = format!("timer {} fired at {at}", self.job());

                self.event(EventKind::TimerFired, at, summary)
            })
            .collect()
    }

    fn missed(&self, first: Timestamp, count: u64) -> Result<Event, PollError> {
        let last = self.firing(first, count.saturating_sub(1))?;
        let summary = format!(
            "timer {} missed {count} firings from {first} to {last}",
            self.job(),
        );

        self.event(EventKind::TimerMissed, first, summary)
    }

    fn outcome(
        &self,
        events: Vec<Event>,
        next: Timestamp,
    ) -> Result<PollOutcome, PollError> {
        let position =
            Position::new(next.to_string()).map_err(|error| self.failed(error))?;

        PollOutcome::new(events, position, Next::Due(next))
            .map_err(|error| self.failed(error))
    }

    fn due_count(&self, due: Timestamp, now: Timestamp) -> Result<u64, PollError> {
        let elapsed = now.as_nanosecond().saturating_sub(due.as_nanosecond());

        if elapsed < 0 {
            return Ok(0);
        }

        let periods = elapsed.checked_div(self.interval).unwrap_or(0);
        let periods = u64::try_from(periods).map_err(|error| self.failed(error))?;

        Ok(periods.saturating_add(1))
    }
}

impl Source for TimerSource {
    fn name(&self) -> &SourceName {
        self.subject.source()
    }

    fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError> {
        let Some(position) = request.position else {
            let next = self.firing(request.now, 1)?;

            return self.outcome(Vec::new(), next);
        };

        let due = position
            .as_str()
            .parse::<Timestamp>()
            .map_err(|error| self.failed(error))?;
        let count = self.due_count(due, request.now)?;
        let within_cap =
            usize::try_from(count).is_ok_and(|count| count <= MAX_EVENTS_PER_POLL);
        let events = if within_cap {
            self.fired(due, count)?
        } else {
            vec![self.missed(due, count)?]
        };

        self.outcome(events, self.firing(due, count)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> Timestamp {
        Timestamp::new(secs, 0).unwrap()
    }

    fn timer(every_secs: u64) -> TimerSource {
        TimerSource::new("deploy".into(), every_secs).unwrap()
    }

    fn poll(
        source: &TimerSource,
        position: Option<Timestamp>,
        now: Timestamp,
    ) -> PollOutcome {
        let position = position.map(|due| Position::new(due.to_string()).unwrap());

        source.poll(PollRequest { now, position }).unwrap()
    }

    fn ids(outcome: &PollOutcome) -> Vec<&str> {
        outcome
            .events()
            .iter()
            .map(|event| event.id().as_str())
            .collect()
    }

    #[test]
    fn the_first_poll_primes_the_next_due_instant_without_events() {
        let outcome = poll(&timer(5), None, at(100));

        assert_eq!(timer(5).name().as_str(), "timer");
        assert_eq!(outcome.events(), []);
        assert_eq!(outcome.position().as_str(), "1970-01-01T00:01:45Z");
        assert_eq!(outcome.next(), Next::Due(at(105)));
    }

    #[test]
    fn a_poll_before_the_due_instant_keeps_the_position() {
        let outcome = poll(&timer(5), Some(at(105)), at(104));

        assert_eq!(outcome.events(), []);
        assert_eq!(outcome.position().as_str(), "1970-01-01T00:01:45Z");
        assert_eq!(outcome.next(), Next::Due(at(105)));
    }

    #[test]
    fn an_on_time_poll_fires_once_and_advances_one_interval() {
        let outcome = poll(&timer(5), Some(at(105)), at(105));
        let [event] = outcome.events() else {
            panic!("expected one event, got {:?}", outcome.events());
        };

        assert_eq!(event.id().as_str(), "timer:deploy:1970-01-01T00:01:45Z");
        assert_eq!(event.kind(), EventKind::TimerFired);
        assert_eq!(event.subject().source().as_str(), "timer");
        assert_eq!(event.subject().key(), "deploy");
        assert_eq!(
            event.summary(),
            "timer deploy fired at 1970-01-01T00:01:45Z"
        );
        assert_eq!(event.at(), at(105));
        assert_eq!(outcome.position().as_str(), "1970-01-01T00:01:50Z");
        assert_eq!(outcome.next(), Next::Due(at(110)));
    }

    #[test]
    fn a_late_poll_catches_up_every_due_firing_in_order() {
        let outcome = poll(&timer(5), Some(at(105)), at(119));
        let instants: Vec<_> = outcome.events().iter().map(Event::at).collect();

        assert_eq!(
            ids(&outcome),
            [
                "timer:deploy:1970-01-01T00:01:45Z",
                "timer:deploy:1970-01-01T00:01:50Z",
                "timer:deploy:1970-01-01T00:01:55Z",
            ]
        );
        assert_eq!(instants, [at(105), at(110), at(115)]);
        assert_eq!(outcome.position().as_str(), "1970-01-01T00:02:00Z");
        assert_eq!(outcome.next(), Next::Due(at(120)));
    }

    #[test]
    fn firings_up_to_the_event_cap_are_each_reported() {
        let outcome = poll(&timer(1), Some(at(0)), at(99));

        assert_eq!(outcome.events().len(), MAX_EVENTS_PER_POLL);
        assert_eq!(outcome.events().last().map(Event::at), Some(at(99)));
        assert_eq!(outcome.next(), Next::Due(at(100)));
    }

    #[test]
    fn firings_past_the_event_cap_become_one_missed_event() {
        let outcome = poll(&timer(1), Some(at(0)), at(100));
        let [event] = outcome.events() else {
            panic!("expected one event, got {:?}", outcome.events());
        };

        assert_eq!(event.id().as_str(), "timer:deploy:1970-01-01T00:00:00Z");
        assert_eq!(event.kind(), EventKind::TimerMissed);
        assert_eq!(
            event.summary(),
            concat!(
                "timer deploy missed 101 firings from ",
                "1970-01-01T00:00:00Z to 1970-01-01T00:01:40Z",
            )
        );
        assert_eq!(event.at(), at(0));
        assert_eq!(outcome.position().as_str(), "1970-01-01T00:01:41Z");
        assert_eq!(outcome.next(), Next::Due(at(101)));
    }

    #[test]
    fn a_reconstructed_source_derives_the_same_ids_from_the_position() {
        let first = poll(&timer(5), Some(at(105)), at(110));
        let again = poll(&timer(5), Some(at(105)), at(110));
        let due = first.position().as_str().parse().unwrap();
        let later = poll(&timer(5), Some(due), at(120));

        assert_eq!(ids(&first), ids(&again));
        assert_eq!(first.position(), again.position());
        assert_eq!(
            ids(&later),
            [
                "timer:deploy:1970-01-01T00:01:55Z",
                "timer:deploy:1970-01-01T00:02:00Z",
            ]
        );
    }

    #[test]
    fn new_rejects_a_zero_interval_and_invalid_jobs() {
        assert_eq!(
            TimerSource::new("deploy".into(), 0),
            Err(ModelError::Invalid {
                field: "timer interval",
                reason: "must be positive",
            })
        );
        assert_eq!(
            TimerSource::new(String::new(), 5),
            Err(ModelError::Empty {
                field: "subject key"
            })
        );
        assert_eq!(
            TimerSource::new("deploy:one".into(), 5),
            Err(ModelError::Invalid {
                field: "event key",
                reason: "must not contain a colon",
            })
        );
        assert_eq!(
            TimerSource::new("x".repeat(250), 5),
            Err(ModelError::TooLong {
                field: "event id",
                limit: crate::MAX_ID_LEN,
            })
        );
    }

    #[test]
    fn new_accepts_an_hour_and_rejects_a_longer_interval() {
        let outcome = poll(&timer(3600), None, at(0));

        assert_eq!(outcome.next(), Next::Due(at(3600)));
        assert_eq!(
            TimerSource::new("deploy".into(), 3601),
            Err(ModelError::Invalid {
                field: "timer interval",
                reason: "must be at most 3600 seconds",
            })
        );
    }

    #[test]
    fn an_unreadable_or_unreachable_position_fails_the_poll() {
        let source = timer(5);
        let garbage = Position::new("soon".into()).unwrap();
        let request = PollRequest {
            now: at(0),
            position: Some(garbage),
        };
        let PollError::Failed { source_name, .. } =
            source.poll(request).unwrap_err();

        assert_eq!(source_name.as_str(), "timer");
        assert!(
            source
                .poll(PollRequest {
                    now: Timestamp::MAX,
                    position: None,
                })
                .is_err()
        );
    }
}
