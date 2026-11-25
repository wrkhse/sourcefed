use std::collections::{BTreeSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use jiff::Timestamp;

use crate::{
    Event, ModelError, MonitorConfig, Next, PollOutcome, PollRequest, PositionKey,
    Source, Store, StoreError,
};

/// Maximum number of seconds the engine sleeps before checking for a stop.
pub const MAX_WAIT_SECS: u64 = 10;
/// Maximum number of events waiting for delivery.
pub const MAX_PENDING_EVENTS: usize = 1000;
/// Maximum default retry delay in seconds.
pub const DEFAULT_BACKOFF_CAP_SECS: u64 = 300;

/// Supplies time and sleep to the poll engine without an async runtime.
pub trait Clock: Send + Sync {
    /// Returns the current instant.
    fn now(&self) -> Timestamp;
    /// Waits for the requested duration.
    fn sleep(&self, duration: Duration);
}

/// Reads wall-clock time and sleeps on the calling thread.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        let system_now = SystemTime::now();
        let Ok(now) = Timestamp::try_from(system_now) else {
            return if system_now < SystemTime::UNIX_EPOCH {
                Timestamp::MIN
            } else {
                Timestamp::MAX
            };
        };

        now
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// A retry delay that starts at the base and doubles up to the cap.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    delay: Duration,
}

impl Backoff {
    /// Starts a backoff at `base`.
    ///
    /// # Errors
    /// Returns an error if the base is zero or the cap is below the base.
    pub fn new(base: Duration, cap: Duration) -> Result<Self, ModelError> {
        if base.is_zero() {
            return Err(ModelError::Invalid {
                field: "backoff base",
                reason: "must be positive",
            });
        }
        if cap < base {
            return Err(ModelError::Invalid {
                field: "backoff cap",
                reason: "must not be below the base",
            });
        }

        Ok(Self {
            base,
            cap,
            delay: base,
        })
    }

    /// Returns the current retry delay.
    #[must_use]
    pub const fn delay(&self) -> Duration {
        self.delay
    }

    /// Resets the delay to the base after a successful poll.
    pub const fn succeed(&mut self) {
        self.delay = self.base;
    }

    /// Doubles the delay without exceeding the cap.
    pub fn fail(&mut self) {
        self.delay = self.delay.saturating_mul(2).min(self.cap);
    }
}

/// Whether the engine can still poll.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineState {
    /// The engine has another poll due.
    Running,
    /// The engine observed a stop request.
    Stopped,
    /// The source finished.
    Ended,
}

/// Requests a stop without taking ownership of the engine.
#[derive(Clone, Debug, Default)]
pub struct StopHandle(Arc<AtomicBool>);

impl StopHandle {
    /// Requests that the engine stop before its next poll.
    pub fn stop(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// Returns whether a stop was requested.
    #[must_use]
    pub fn is_stopped(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Events waiting for delivery, oldest first, with a count of dropped events.
#[derive(Debug, Default, Eq, PartialEq)]
pub struct PendingEvents {
    events: VecDeque<Event>,
    dropped: usize,
}

impl PendingEvents {
    /// Appends events, dropping and counting the oldest whenever the queue is full.
    pub fn push(&mut self, events: Vec<Event>) {
        for event in events {
            if self.events.len() == MAX_PENDING_EVENTS {
                self.events.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }

            self.events.push_back(event);
        }
    }

    /// Drains the events in queue order and resets the count of dropped events.
    #[must_use]
    pub fn take(&mut self) -> (Vec<Event>, usize) {
        let pending = std::mem::take(self);

        (pending.events.into(), pending.dropped)
    }
}

/// A failure to commit a poll outcome to the store.
///
/// Source failures schedule a retry with backoff and are not returned here.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    /// The outcome could not be committed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

enum Schedule {
    Due(Timestamp),
    Stopped,
    Ended,
}

/// Polls one source at a time and queues distinct new events after a successful commit.
///
/// A successful outcome sets the next due time or ends the engine. A source failure
/// schedules a retry with backoff; it is not returned as an error.
pub struct PollEngine {
    config: MonitorConfig,
    source: Arc<dyn Source>,
    store: Store,
    clock: Arc<dyn Clock>,
    schedule: Schedule,
    backoff: Backoff,
    stop: StopHandle,
    pending: PendingEvents,
}

impl PollEngine {
    /// Creates an engine whose first poll is due immediately.
    ///
    /// The retry base is the poll interval, limited by the default cap.
    ///
    /// # Errors
    /// Returns an error if the source's name differs from the configuration.
    pub fn new(
        config: MonitorConfig,
        source: Arc<dyn Source>,
        store: Store,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, ModelError> {
        if source.name() != &config.source {
            return Err(ModelError::Invalid {
                field: "monitor source",
                reason: "must match the source name",
            });
        }

        let cap = Duration::from_secs(DEFAULT_BACKOFF_CAP_SECS);
        let base = Duration::from_secs(config.poll_interval.as_secs()).min(cap);
        let backoff = Backoff::new(base, cap)?;
        let schedule = Schedule::Due(clock.now());

        Ok(Self {
            config,
            source,
            store,
            clock,
            schedule,
            backoff,
            stop: StopHandle::default(),
            pending: PendingEvents::default(),
        })
    }

    /// Returns a handle that can request a stop from another thread.
    #[must_use]
    pub fn handle(&self) -> StopHandle {
        self.stop.clone()
    }

    /// Returns the last state observed by the engine.
    #[must_use]
    pub const fn state(&self) -> EngineState {
        match self.schedule {
            Schedule::Due(_) => EngineState::Running,
            Schedule::Stopped => EngineState::Stopped,
            Schedule::Ended => EngineState::Ended,
        }
    }

    /// Returns the queue of committed events waiting for delivery.
    #[must_use]
    pub const fn pending(&self) -> &PendingEvents {
        &self.pending
    }

    /// Advances the engine by at most `max_polls` iterations.
    ///
    /// Each iteration waits at most once, for at most ten seconds, and polls only
    /// when due. A wait that ends before the due time consumes an iteration without
    /// polling. The engine checks for a stop before and after sleeping.
    ///
    /// Source failures schedule a retry with backoff and do not return an error.
    ///
    /// # Errors
    /// Returns a store error if committing an outcome fails.
    pub fn run(&mut self, max_polls: u32) -> Result<EngineState, EngineError> {
        for _ in 0..max_polls {
            let Schedule::Due(due) = self.schedule else {
                break;
            };

            if self.stop.is_stopped() {
                self.schedule = Schedule::Stopped;
                break;
            }

            let mut now = self.clock.now();

            if now < due {
                let remaining = due.duration_since(now).unsigned_abs();
                self.clock
                    .sleep(remaining.min(Duration::from_secs(MAX_WAIT_SECS)));
                now = self.clock.now();
            }

            if self.stop.is_stopped() {
                self.schedule = Schedule::Stopped;
                break;
            }

            if now >= due {
                self.poll(now)?;
            }
        }

        Ok(self.state())
    }

    fn poll(&mut self, now: Timestamp) -> Result<(), StoreError> {
        let key = PositionKey {
            monitor: self.config.id.clone(),
            source: self.config.source.clone(),
        };
        let request = PollRequest {
            now,
            position: self.store.position(&key).cloned(),
        };

        if let Ok(outcome) = self.source.poll(request) {
            return self.commit(key, &outcome);
        }

        self.backoff.fail();
        let due = self
            .clock
            .now()
            .checked_add(self.backoff.delay())
            .unwrap_or(Timestamp::MAX);
        self.schedule = Schedule::Due(due);

        Ok(())
    }

    fn commit(
        &mut self,
        key: PositionKey,
        outcome: &PollOutcome,
    ) -> Result<(), StoreError> {
        let mut distinct = BTreeSet::new();
        let fresh: Vec<_> = outcome
            .events()
            .iter()
            .filter(|event| {
                !self.store.is_seen(&key, event.id()) && distinct.insert(event.id())
            })
            .cloned()
            .collect();

        let count =
            self.store
                .commit(key, outcome.position().clone(), outcome.events())?;
        debug_assert_eq!(count, fresh.len());

        self.pending.push(fresh);
        self.backoff.succeed();
        self.schedule = match outcome.next() {
            Next::Due(due) => Schedule::Due(due),
            Next::Done => Schedule::Ended,
        };

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::source::MAX_EVENTS_PER_POLL;
    use crate::{
        EventId, EventKind, EventSubject, MonitorId, PollError, PollInterval,
        Position, SourceName,
    };

    #[derive(Default)]
    struct FakeClock {
        now: Mutex<Timestamp>,
        sleeps: Mutex<Vec<Duration>>,
        stop_on_sleep: Mutex<Option<StopHandle>>,
    }

    impl Clock for FakeClock {
        fn now(&self) -> Timestamp {
            *self.now.lock().unwrap()
        }

        fn sleep(&self, duration: Duration) {
            self.sleeps.lock().unwrap().push(duration);
            let mut now = self.now.lock().unwrap();
            *now = now.checked_add(duration).unwrap();
            drop(now);

            let handle = self.stop_on_sleep.lock().unwrap().take();

            if let Some(handle) = handle {
                handle.stop();
            }
        }
    }

    struct FakeSource {
        name: SourceName,
        results: Mutex<VecDeque<Result<PollOutcome, PollError>>>,
        requests: Mutex<Vec<PollRequest>>,
    }

    impl Source for FakeSource {
        fn name(&self) -> &SourceName {
            &self.name
        }

        fn poll(&self, request: PollRequest) -> Result<PollOutcome, PollError> {
            self.requests.lock().unwrap().push(request);

            self.results.lock().unwrap().pop_front().unwrap()
        }
    }

    struct Fixture {
        engine: PollEngine,
        _dir: tempfile::TempDir,
        clock: Arc<FakeClock>,
        source: Arc<FakeSource>,
    }

    impl Fixture {
        fn new(interval: u64, results: Vec<Result<PollOutcome, PollError>>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(dir.path()).unwrap();
            let clock = Arc::new(FakeClock::default());
            let source = Arc::new(FakeSource {
                name: timer(),
                results: Mutex::new(results.into()),
                requests: Mutex::new(Vec::new()),
            });
            let key = key();
            let config = MonitorConfig {
                id: key.monitor,
                source: key.source,
                poll_interval: PollInterval::from_secs(interval).unwrap(),
            };
            let engine =
                PollEngine::new(config, source.clone(), store, clock.clone())
                    .unwrap();

            Self {
                engine,
                _dir: dir,
                clock,
                source,
            }
        }

        fn sleeps(&self) -> Vec<Duration> {
            self.clock.sleeps.lock().unwrap().clone()
        }

        fn requests(&self) -> Vec<PollRequest> {
            self.source.requests.lock().unwrap().clone()
        }
    }

    fn at(secs: i64) -> Timestamp {
        Timestamp::new(secs, 0).unwrap()
    }

    fn timer() -> SourceName {
        SourceName::new("timer".into()).unwrap()
    }

    fn key() -> PositionKey {
        PositionKey {
            monitor: MonitorId::new("monitor".into()).unwrap(),
            source: timer(),
        }
    }

    fn cursor() -> Position {
        Position::new("cursor".into()).unwrap()
    }

    fn outcome(next: Next) -> PollOutcome {
        PollOutcome::new(Vec::new(), cursor(), next).unwrap()
    }

    fn event(id: &str) -> Event {
        let subject = EventSubject::new(timer(), "subject".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            at(0),
        )
        .unwrap()
    }

    #[test]
    fn first_poll_runs_immediately() {
        let mut f = Fixture::new(5, vec![Ok(outcome(Next::Due(at(5))))]);

        assert_eq!(f.engine.run(0).unwrap(), EngineState::Running);
        assert_eq!(f.requests(), []);
        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
        assert_eq!(
            f.requests(),
            [PollRequest {
                now: at(0),
                position: None,
            }]
        );
        assert_eq!(f.sleeps(), []);
        assert_eq!(f.engine.store.position(&key()), Some(&cursor()));
    }

    #[test]
    fn on_time_poll_waits_the_full_interval_in_bounded_sleeps() {
        let mut f = Fixture::new(
            25,
            vec![
                Ok(outcome(Next::Due(at(25)))),
                Ok(outcome(Next::Due(at(50)))),
            ],
        );

        assert_eq!(f.engine.run(3).unwrap(), EngineState::Running);
        assert_eq!(f.requests().len(), 1);
        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
        assert_eq!(f.sleeps(), [10, 10, 5].map(Duration::from_secs));
        assert_eq!(
            f.requests(),
            [
                PollRequest {
                    now: at(0),
                    position: None,
                },
                PollRequest {
                    now: at(25),
                    position: Some(cursor()),
                },
            ]
        );
    }

    #[test]
    fn a_late_clock_catches_up_with_one_poll() {
        let mut f = Fixture::new(
            5,
            vec![
                Ok(outcome(Next::Due(at(5)))),
                Ok(outcome(Next::Due(at(25)))),
            ],
        );
        f.engine.run(1).unwrap();
        *f.clock.now.lock().unwrap() = at(20);

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
        assert_eq!(f.sleeps(), []);
        assert_eq!(
            f.requests(),
            [
                PollRequest {
                    now: at(0),
                    position: None,
                },
                PollRequest {
                    now: at(20),
                    position: Some(cursor()),
                },
            ]
        );
    }

    #[test]
    fn retries_double_to_the_cap_and_recovery_resets_the_delay() {
        let failed = PollError::Failed {
            source_name: timer(),
            message: "temporarily unavailable".into(),
        };
        let mut f = Fixture::new(
            75,
            vec![
                Err(failed.clone()),
                Err(failed.clone()),
                Err(failed.clone()),
                Ok(outcome(Next::Due(at(750)))),
                Err(failed),
                Ok(outcome(Next::Done)),
            ],
        );

        assert_eq!(f.engine.run(100).unwrap(), EngineState::Ended);
        assert_eq!(f.sleeps(), [Duration::from_secs(10); 90]);
        assert_eq!(
            f.requests()
                .into_iter()
                .map(|request| request.now)
                .collect::<Vec<_>>(),
            [0, 150, 450, 750, 750, 900].map(at)
        );
    }

    #[test]
    fn a_stop_requested_during_sleep_prevents_the_next_poll() {
        let mut f = Fixture::new(5, vec![Ok(outcome(Next::Due(at(5))))]);
        f.engine.run(1).unwrap();
        let handle = f.engine.handle();
        *f.clock.stop_on_sleep.lock().unwrap() = Some(handle.clone());

        assert_eq!(
            (handle.is_stopped(), f.engine.state()),
            (false, EngineState::Running)
        );
        assert_eq!(f.engine.run(5).unwrap(), EngineState::Stopped);
        assert_eq!(
            (handle.is_stopped(), f.engine.run(5).unwrap()),
            (true, EngineState::Stopped)
        );
        assert_eq!(f.sleeps(), [Duration::from_secs(5)]);
        assert_eq!(f.requests().len(), 1);
    }

    #[test]
    fn an_oversized_outcome_is_rejected_without_changing_the_engine_or_store() {
        let f = Fixture::new(5, Vec::new());
        let event = event("first");
        let oversized = vec![event.clone(); MAX_EVENTS_PER_POLL + 1];

        assert_eq!(
            PollOutcome::new(oversized, cursor(), Next::Done).unwrap_err(),
            ModelError::TooMany {
                field: "poll outcome events",
                limit: MAX_EVENTS_PER_POLL,
            }
        );
        assert_eq!(f.engine.state(), EngineState::Running);
        assert_eq!(f.engine.pending(), &PendingEvents::default());
        assert_eq!(
            (
                f.engine.store.position(&key()),
                f.engine.store.is_seen(&key(), event.id()),
            ),
            (None, false)
        );
        assert_eq!(f.requests(), []);
    }

    #[test]
    fn a_done_outcome_ends_the_engine() {
        let mut f = Fixture::new(5, vec![Ok(outcome(Next::Done))]);

        assert_eq!(f.engine.run(5).unwrap(), EngineState::Ended);
        assert_eq!(f.engine.run(5).unwrap(), EngineState::Ended);
        assert_eq!(f.requests().len(), 1);
        assert_eq!(f.sleeps(), []);
        assert_eq!(f.engine.store.position(&key()), Some(&cursor()));
    }

    #[test]
    fn pending_keeps_only_new_events_in_their_original_order() {
        let first = event("first");
        let second = event("second");
        let third = event("third");
        let initial = vec![first.clone(), first.clone()];
        let later = vec![third.clone(), first.clone(), second.clone()];
        let mut f = Fixture::new(
            5,
            vec![
                Ok(PollOutcome::new(initial, cursor(), Next::Due(at(5))).unwrap()),
                Ok(PollOutcome::new(later, cursor(), Next::Done).unwrap()),
            ],
        );

        assert_eq!(f.engine.run(2).unwrap(), EngineState::Ended);
        assert_eq!(f.engine.pending.take(), (vec![first, third, second], 0));
    }

    #[test]
    fn a_full_pending_queue_drops_the_oldest_and_take_resets_it() {
        let events: Vec<_> = (0..MAX_PENDING_EVENTS + 2)
            .map(|index| event(&format!("event-{index}")))
            .collect();
        let expected = events.iter().skip(2).cloned().collect();
        let mut pending = PendingEvents::default();

        pending.push(events[..MAX_PENDING_EVENTS].to_vec());
        pending.push(events[MAX_PENDING_EVENTS..].to_vec());

        assert_eq!(pending.take(), (expected, 2));
        assert_eq!(pending.take(), (Vec::new(), 0));
    }

    #[test]
    fn backoff_validates_bounds_and_saturates_without_overflow() {
        let base = Duration::from_secs(1);
        assert_eq!(
            Backoff::new(Duration::ZERO, base).unwrap_err(),
            ModelError::Invalid {
                field: "backoff base",
                reason: "must be positive",
            }
        );
        assert_eq!(
            Backoff::new(base, Duration::ZERO).unwrap_err(),
            ModelError::Invalid {
                field: "backoff cap",
                reason: "must not be below the base",
            }
        );

        let base = Duration::from_secs(u64::MAX);
        let mut backoff = Backoff::new(base, Duration::MAX).unwrap();

        backoff.fail();
        assert_eq!(backoff.delay(), Duration::MAX);
        backoff.succeed();
        assert_eq!(backoff.delay(), base);
    }
}
