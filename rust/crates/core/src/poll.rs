use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use jiff::Timestamp;

pub use crate::store::MAX_PENDING_EVENTS;
use crate::{
    Event, ModelError, MonitorConfig, Next, PollOutcome, PollRequest, PositionKey,
    Source, Store, StoreError,
};

/// Maximum number of seconds the engine sleeps before checking for a stop.
pub const MAX_WAIT_SECS: u64 = 10;
/// Maximum default retry delay in seconds.
pub const DEFAULT_BACKOFF_CAP_SECS: u64 = 300;

const ITERATIONS_PER_POLL: u64 =
    DEFAULT_BACKOFF_CAP_SECS.div_ceil(MAX_WAIT_SECS) + 1;

/// Supplies time and sleep to the poll engine without an async runtime.
pub trait Clock: Send + Sync {
    /// Returns the current instant.
    fn now(&self) -> Timestamp;
    /// Waits for the requested duration.
    fn sleep(&self, duration: Duration);
}

/// Reads wall-clock time and sleeps on the calling thread.
///
/// Returns [`Timestamp::MIN`] if the wall clock is outside Jiff's range.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    #[expect(
        clippy::option_if_let_else,
        reason = "match explicitly on the out-of-range wall-clock reading"
    )]
    fn now(&self) -> Timestamp {
        match Timestamp::try_from(SystemTime::now()) {
            Ok(now) => now,
            Err(_) => Timestamp::MIN,
        }
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
    /// The engine has a poll scheduled, which may be in the future.
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

/// Polls one source at a time and saves fresh events with the source position.
///
/// Pending events live in the store. A successful outcome sets the next due
/// time or ends the engine. A source failure schedules a retry with backoff;
/// it is not returned as an error.
pub struct PollEngine {
    config: MonitorConfig,
    source: Arc<dyn Source>,
    store: Store,
    clock: Arc<dyn Clock>,
    schedule: Schedule,
    backoff: Backoff,
    stop: StopHandle,
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

    /// Returns the store's durable queue of events waiting for delivery, oldest first.
    #[must_use]
    pub const fn pending(&self) -> &VecDeque<Event> {
        self.store.pending()
    }

    /// Drains the store's pending queue, persists it empty, and returns its events.
    ///
    /// # Errors
    /// Returns [`StoreError::TooLarge`] if the serialized state exceeds the byte
    /// limit, or [`StoreError::Write`] if serialization, writing, syncing or
    /// renaming fails. The in-memory queue is unchanged on error. A directory
    /// sync error can occur after the saved file has been replaced.
    pub fn take_pending(&mut self) -> Result<Vec<Event>, StoreError> {
        self.store.take_pending()
    }

    /// Consumes the engine and returns its store.
    #[must_use]
    pub fn into_store(self) -> Store {
        self.store
    }

    /// Advances the engine by at most `max_polls` source polls and a bounded
    /// number of wait iterations.
    ///
    /// The iteration budget is `max_polls` times the number of ten-second
    /// waits in the default backoff cap (rounded up), plus one per poll.
    /// Each iteration waits at most once and checks for a stop before and
    /// after sleeping. If the due time has not arrived, the iteration counts
    /// toward the iteration budget but not the poll budget.
    ///
    /// Source failures schedule a retry with backoff and do not return an error.
    ///
    /// # Errors
    /// Returns a store error if committing an outcome fails.
    pub fn run(&mut self, max_polls: u32) -> Result<EngineState, EngineError> {
        let max_iterations =
            u64::from(max_polls).saturating_mul(ITERATIONS_PER_POLL);
        let mut polls = 0_u32;

        for _ in 0..max_iterations {
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

            if now < due {
                continue;
            }

            self.poll(now)?;
            polls = polls.saturating_add(1);

            if polls == max_polls {
                break;
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
        self.store
            .commit(key, outcome.position().clone(), outcome.events())?;

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
    use std::time::Instant;

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
        dir: tempfile::TempDir,
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
                dir,
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
    fn system_clock_reads_the_current_time() {
        let before = Timestamp::now();
        let now = SystemClock.now();
        let after = Timestamp::now();

        assert!(before <= now);
        assert!(now <= after);
    }

    #[test]
    fn system_clock_sleeps_at_least_the_requested_duration() {
        let duration = Duration::from_millis(2);
        let start = Instant::now();
        SystemClock.sleep(duration);

        assert!(start.elapsed() >= duration);
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
    fn a_one_poll_budget_stops_even_when_the_next_poll_is_due() {
        let mut f = Fixture::new(
            5,
            vec![Ok(outcome(Next::Due(at(0)))), Ok(outcome(Next::Done))],
        );

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
        assert_eq!(
            f.requests(),
            [PollRequest {
                now: at(0),
                position: None,
            }]
        );
        assert_eq!(f.sleeps(), []);
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

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
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
    fn a_distant_due_time_exhausts_the_iteration_budget_without_polling() {
        let mut f = Fixture::new(
            5,
            vec![Ok(outcome(Next::Due(at(3600)))), Ok(outcome(Next::Done))],
        );
        f.engine.run(1).unwrap();

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
        assert_eq!(f.sleeps(), [Duration::from_secs(10); 31]);
        assert_eq!(
            f.requests(),
            [PollRequest {
                now: at(0),
                position: None,
            }]
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
        assert_eq!(f.engine.pending(), &VecDeque::new());
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
        let expected = VecDeque::from([first, third, second]);

        assert_eq!(f.engine.pending(), &expected);
        assert_eq!(f.engine.take_pending().unwrap(), Vec::from(expected));
        assert_eq!(f.engine.take_pending().unwrap(), []);
    }

    #[test]
    fn pending_overflow_leaves_the_schedule_and_store_unchanged() {
        let initial: Vec<_> = (0..MAX_PENDING_EVENTS)
            .map(|index| event(&format!("event-{index}")))
            .collect();
        let fresh = event("overflow");
        let next = Position::new("next".into()).unwrap();
        let overflow = PollOutcome::new(vec![fresh.clone()], next, Next::Done);
        let mut f = Fixture::new(5, vec![Ok(overflow.unwrap())]);
        assert_eq!(
            f.engine.store.commit(key(), cursor(), &initial).unwrap(),
            MAX_PENDING_EVENTS
        );
        f.engine.backoff.fail();
        let backoff = f.engine.backoff;

        let error = f.engine.run(1).unwrap_err();
        let EngineError::Store(StoreError::TooMany { limit }) = error else {
            panic!("expected too many pending events, got {error:?}");
        };

        assert_eq!(limit, MAX_PENDING_EVENTS);
        assert_eq!(f.engine.state(), EngineState::Running);
        assert!(matches!(f.engine.schedule, Schedule::Due(due) if due == at(0)));
        assert_eq!(f.engine.backoff, backoff);
        assert_eq!(f.engine.pending(), &VecDeque::from(initial));
        assert_eq!(
            (
                f.engine.store.position(&key()),
                f.engine.store.is_seen(&key(), fresh.id()),
            ),
            (Some(&cursor()), false)
        );
    }

    #[test]
    fn a_finished_engines_position_and_pending_events_survive_reopen() {
        let events = vec![event("first"), event("second")];
        let outcome = PollOutcome::new(events.clone(), cursor(), Next::Done);
        let mut f = Fixture::new(5, vec![Ok(outcome.unwrap())]);

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Ended);
        let store = f.engine.into_store();
        drop(store);

        let reopened = Store::open(f.dir.path()).unwrap();

        assert_eq!(reopened.position(&key()), Some(&cursor()));
        assert_eq!(reopened.pending(), &VecDeque::from(events));
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
