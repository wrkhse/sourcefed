use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use jiff::Timestamp;

pub use crate::store::MAX_PENDING_EVENTS;
use crate::{
    Event, EventId, ModelError, MonitorConfig, Next, PollOutcome, PollRequest,
    PositionKey, Source, StateStore, Store, StoreError,
};

/// Maximum number of seconds the engine sleeps before checking for a stop.
pub const MAX_WAIT_SECS: u64 = 10;
/// Maximum default retry delay in seconds.
pub const DEFAULT_BACKOFF_CAP_SECS: u64 = 300;

const ITERATIONS_PER_POLL: u64 =
    DEFAULT_BACKOFF_CAP_SECS.div_ceil(MAX_WAIT_SECS) + 1;

/// A clock reading outside the timestamp range.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ClockError {
    /// The reading is earlier than [`Timestamp::MIN`].
    #[error("past clock out of range")]
    Past,
    /// The reading is later than [`Timestamp::MAX`].
    #[error("future clock out of range")]
    Future,
}

/// Supplies time and sleep to the poll engine without an async runtime.
pub trait Clock: Send + Sync {
    /// Returns the current instant.
    ///
    /// # Errors
    /// Returns [`ClockError::Past`] if the reading is before the timestamp
    /// range, or [`ClockError::Future`] if it is after the range.
    fn now(&self) -> Result<Timestamp, ClockError>;
    /// Waits for the requested duration.
    fn sleep(&self, duration: Duration);
}

/// Reads wall-clock time and sleeps on the calling thread.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Result<Timestamp, ClockError> {
        timestamp_from(SystemTime::now())
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

fn timestamp_from(system_now: SystemTime) -> Result<Timestamp, ClockError> {
    Timestamp::try_from(system_now).map_err(|_| {
        // If the platform cannot represent a bound, the epoch still tells
        // which side of the timestamp range this failed reading is on.
        let min =
            SystemTime::try_from(Timestamp::MIN).unwrap_or(SystemTime::UNIX_EPOCH);
        let max =
            SystemTime::try_from(Timestamp::MAX).unwrap_or(SystemTime::UNIX_EPOCH);
        let nearest = system_now.max(min).min(max);

        if system_now.cmp(&nearest).is_lt() {
            ClockError::Past
        } else {
            ClockError::Future
        }
    })
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
    /// Returns [`ModelError::Invalid`] if the base is zero or the cap is
    /// below the base.
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
    /// The engine observed a stop request or an out-of-range past clock reading.
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

    /// Returns whether a stop is requested.
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
    /// The outcome cannot be committed. The store returns
    /// [`StoreError::TooMany`] when a pending queue is full or too few seen
    /// IDs can be evicted.
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Clone, Copy)]
enum Schedule {
    Due(Timestamp),
    Stopped,
    Ended,
}

impl Schedule {
    fn after_clock_error(self, error: ClockError) -> Self {
        let (schedule, action) = match error {
            ClockError::Past => (Self::Stopped, "polling stopped"),
            ClockError::Future => (self, "polling deferred"),
        };
        tracing::warn!(reason = %error, "{action}");

        schedule
    }
}

/// Polls one source at a time and saves fresh events with the source position.
///
/// The store owns a bounded pending queue for this engine's position key.
/// The engine exposes a read-only view and removes delivered events by ID.
/// A successful commit sets the next due time or ends the engine. A source
/// failure schedules a retry with backoff; it is not returned as an error.
pub struct PollEngine<S = Store> {
    key: PositionKey,
    source: Arc<dyn Source>,
    store: S,
    clock: Arc<dyn Clock>,
    schedule: Schedule,
    backoff: Backoff,
    stop: StopHandle,
}

impl<S: StateStore> PollEngine<S> {
    /// Creates an engine whose first poll is due at the current clock reading.
    ///
    /// The retry base is the poll interval, limited by the default cap.
    /// An out-of-range past reading stops the engine. An out-of-range future
    /// reading makes the first poll due at the earliest timestamp, so it runs
    /// at the first representable reading. Both log a warning as described in
    /// [`PollEngine::run`].
    ///
    /// # Errors
    /// Returns [`ModelError::Invalid`] if the source's name differs from
    /// the configuration or the retry backoff is invalid.
    pub fn new(
        config: MonitorConfig,
        source: Arc<dyn Source>,
        store: S,
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
        let schedule = clock.now().map_or_else(
            |error| Schedule::Due(Timestamp::MIN).after_clock_error(error),
            Schedule::Due,
        );
        let key = PositionKey {
            monitor: config.id,
            source: config.source,
        };

        Ok(Self {
            key,
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

    /// Returns a copy of the queue for this engine's key, oldest first,
    /// or `None` if absent.
    #[must_use]
    pub fn pending(&self) -> Option<VecDeque<Event>> {
        self.store.pending(&self.key)
    }

    /// Acknowledges IDs through the store using this engine's position key.
    /// Returns the number of events removed from its queue. Unknown IDs are
    /// ignored, and the store atomically saves any removal.
    ///
    /// # Errors
    /// Returns [`StoreError::Write`] or [`StoreError::TooLarge`] if the
    /// acknowledgement cannot be saved.
    pub fn ack(&mut self, ids: &[EventId]) -> Result<usize, StoreError> {
        self.store.ack_pending(&self.key, ids)
    }

    /// Consumes the engine and returns its store.
    #[must_use]
    pub fn into_store(self) -> S {
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
    /// An out-of-range past clock reading stops the engine and logs a
    /// `polling stopped` warning with the reason `past clock out of range`.
    /// An out-of-range future reading logs a `polling deferred` warning with
    /// the reason `future clock out of range`, keeps the due time, waits at
    /// most ten seconds, and ends the run without polling. A later run with a
    /// representable reading polls once that due time arrives. Neither
    /// reading counts as due.
    ///
    /// Source failures schedule a retry with backoff and do not return an error.
    ///
    /// # Errors
    /// Returns [`EngineError::Store`] if committing an outcome fails,
    /// including [`StoreError::TooMany`] when a batch exceeds the key's
    /// available pending capacity or the fresh ID limit, or when too few
    /// seen IDs can be evicted without losing pending IDs. A full pending
    /// queue refuses fresh events until pending events are acknowledged.
    pub fn run(&mut self, max_polls: u32) -> Result<EngineState, EngineError> {
        let max_iterations =
            u64::from(max_polls).saturating_mul(ITERATIONS_PER_POLL);
        let max_wait = Duration::from_secs(MAX_WAIT_SECS);
        let mut polls = 0_u32;

        for _ in 0..max_iterations {
            let Schedule::Due(due) = self.schedule else {
                break;
            };

            if self.stop.is_stopped() {
                self.schedule = Schedule::Stopped;
                break;
            }

            let mut now = self.read_clock();

            match now {
                Ok(reading) if reading < due => {
                    let remaining = due.duration_since(reading).unsigned_abs();
                    self.clock.sleep(remaining.min(max_wait));
                    now = self.read_clock();
                }
                Err(ClockError::Future) => self.clock.sleep(max_wait),
                Ok(_) | Err(ClockError::Past) => {}
            }

            if self.stop.is_stopped() {
                self.schedule = Schedule::Stopped;
                break;
            }

            let Ok(now) = now else {
                break;
            };

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

    fn read_clock(&mut self) -> Result<Timestamp, ClockError> {
        self.clock.now().inspect_err(|&error| {
            self.schedule = self.schedule.after_clock_error(error);
        })
    }

    fn poll(&mut self, now: Timestamp) -> Result<(), StoreError> {
        let request = PollRequest {
            now,
            position: self.store.position(&self.key),
        };

        if let Ok(outcome) = self.source.poll(request) {
            return self.commit(&outcome);
        }

        self.backoff.fail();

        if let Ok(now) = self.read_clock() {
            let due = now
                .checked_add(self.backoff.delay())
                .unwrap_or(Timestamp::MAX);
            self.schedule = Schedule::Due(due);
        }

        Ok(())
    }

    fn commit(&mut self, outcome: &PollOutcome) -> Result<(), StoreError> {
        self.store.commit(
            self.key.clone(),
            outcome.position().clone(),
            outcome.events(),
        )?;

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
    use std::fs;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    use super::*;
    use crate::{
        EventKind, EventSubject, MonitorId, PollError, PollInterval, Position,
        SourceName,
    };

    #[derive(Default)]
    struct FakeClock {
        now: Mutex<Timestamp>,
        readings: Mutex<VecDeque<Result<Timestamp, ClockError>>>,
        sleeps: Mutex<Vec<Duration>>,
        stop_on_sleep: Mutex<Option<StopHandle>>,
    }

    impl Clock for FakeClock {
        fn now(&self) -> Result<Timestamp, ClockError> {
            let reading = self.readings.lock().unwrap().pop_front();

            if let Some(reading) = reading {
                return reading;
            }

            Ok(*self.now.lock().unwrap())
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
        let now = SystemClock.now().unwrap();
        let after = Timestamp::now();

        assert!(before <= now);
        assert!(now <= after);
    }

    #[test]
    fn system_clock_returns_a_representable_reading_in_normal_runs() {
        assert_ne!(SystemClock.now().unwrap(), Timestamp::MAX);
    }

    #[test]
    fn system_clock_sleeps_at_least_the_requested_duration() {
        let duration = Duration::from_millis(2);
        let start = Instant::now();
        SystemClock.sleep(duration);

        assert!(start.elapsed() >= duration);
    }

    #[test]
    fn timestamp_from_rejects_a_reading_before_the_minimum() {
        let min = SystemTime::try_from(Timestamp::MIN).unwrap();
        let before = min.checked_sub(Duration::from_secs(1)).unwrap();

        assert_eq!(timestamp_from(before), Err(ClockError::Past));
    }

    #[test]
    fn timestamp_from_rejects_a_reading_after_the_maximum() {
        let max = SystemTime::try_from(Timestamp::MAX).unwrap();
        let after = max.checked_add(Duration::from_secs(1)).unwrap();

        assert_eq!(timestamp_from(after), Err(ClockError::Future));
    }

    #[test]
    fn timestamp_from_converts_a_representable_reading() {
        assert_eq!(timestamp_from(SystemTime::UNIX_EPOCH), Ok(at(0)));
    }

    #[test]
    fn an_out_of_range_past_reading_stops_without_polling() {
        let mut f = Fixture::new(5, vec![Ok(outcome(Next::Done))]);
        f.clock
            .readings
            .lock()
            .unwrap()
            .push_back(Err(ClockError::Past));

        assert_eq!(f.engine.run(1).unwrap(), EngineState::Stopped);
        assert_eq!(f.engine.run(1).unwrap(), EngineState::Stopped);
        assert_eq!(f.requests(), []);
        assert_eq!(f.sleeps(), []);
    }

    #[test]
    fn a_future_reading_keeps_the_due_time_and_polls_once_after_recovery() {
        for (next, state) in [
            (Next::Done, EngineState::Ended),
            (Next::Due(at(3600)), EngineState::Running),
        ] {
            let mut f = Fixture::new(5, vec![Ok(outcome(next))]);
            f.clock
                .readings
                .lock()
                .unwrap()
                .push_back(Err(ClockError::Future));

            assert_eq!(f.engine.run(1).unwrap(), EngineState::Running);
            assert!(matches!(f.engine.schedule, Schedule::Due(due) if due == at(0)));
            assert_eq!(f.requests(), []);

            assert_eq!(f.engine.run(1).unwrap(), state);
            assert_eq!(f.sleeps(), [Duration::from_secs(10)]);
            assert_eq!(
                f.requests(),
                [PollRequest {
                    now: at(10),
                    position: None,
                }]
            );
        }
    }

    #[test]
    fn an_out_of_range_reading_after_sleep_does_not_count_as_due() {
        for (error, state) in [
            (ClockError::Past, EngineState::Stopped),
            (ClockError::Future, EngineState::Running),
        ] {
            let mut f = Fixture::new(5, vec![Ok(outcome(Next::Due(at(5))))]);
            f.engine.run(1).unwrap();
            f.clock
                .readings
                .lock()
                .unwrap()
                .extend([Ok(at(0)), Err(error)]);

            assert_eq!(f.engine.run(1).unwrap(), state);
            assert_eq!(f.sleeps(), [Duration::from_secs(5)]);
            assert_eq!(
                f.requests(),
                [PollRequest {
                    now: at(0),
                    position: None
                }]
            );
        }
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
    fn a_full_durable_queue_makes_the_engine_refuse_a_commit_with_too_many() {
        let initial: Vec<_> = (0..MAX_PENDING_EVENTS)
            .map(|index| event(&format!("event-{index}")))
            .collect();
        let fresh = event("overflow");
        let next = Position::new("next".into()).unwrap();
        let result = PollOutcome::new(vec![fresh.clone()], next, Next::Done);
        let mut f = Fixture::new(5, vec![Ok(result.unwrap())]);

        assert_eq!(
            f.engine.store.commit(key(), cursor(), &initial).unwrap(),
            MAX_PENDING_EVENTS
        );
        let path = f.dir.path().join("positions.json");
        let before = fs::read(&path).unwrap();

        let error = f.engine.run(1).unwrap_err();
        let EngineError::Store(StoreError::TooMany { limit }) = error else {
            panic!("expected too many pending events, got {error:?}");
        };

        assert_eq!(limit, MAX_PENDING_EVENTS);
        assert_eq!(
            f.requests(),
            [PollRequest {
                now: at(0),
                position: Some(cursor()),
            }]
        );
        assert_eq!(f.engine.state(), EngineState::Running);
        assert_eq!(f.engine.pending(), Some(VecDeque::from(initial)));
        assert_eq!(
            (
                f.engine.store.position(&key()),
                f.engine.store.is_seen(&key(), fresh.id()),
            ),
            (Some(&cursor()), false)
        );
        assert_eq!(fs::read(path).unwrap(), before);
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

        assert_eq!(f.engine.pending(), Some(expected));
    }

    #[test]
    fn ack_removes_only_matching_events_from_the_engines_key() {
        let first = event("first");
        let shared = event("shared");
        let last = event("last");
        let batch = vec![first.clone(), shared.clone(), last.clone()];
        let outcome = PollOutcome::new(batch, cursor(), Next::Done).unwrap();
        let mut f = Fixture::new(5, vec![Ok(outcome)]);
        let other = PositionKey {
            monitor: MonitorId::new("other".into()).unwrap(),
            source: timer(),
        };
        let unknown = EventId::new("unknown".into()).unwrap();
        let duplicate_ids = [shared.id().clone(), shared.id().clone()];

        assert_eq!(f.engine.ack(&duplicate_ids).unwrap(), 0);
        assert_eq!(f.engine.pending(), None);
        assert_eq!(
            f.engine
                .store
                .commit(other.clone(), cursor(), std::slice::from_ref(&shared))
                .unwrap(),
            1
        );
        assert_eq!(f.engine.run(1).unwrap(), EngineState::Ended);
        assert_eq!(f.engine.ack(&[]).unwrap(), 0);
        assert_eq!(f.engine.ack(&[unknown]).unwrap(), 0);
        assert_eq!(f.engine.ack(&duplicate_ids).unwrap(), 1);
        assert_eq!(f.engine.ack(std::slice::from_ref(shared.id())).unwrap(), 0);
        assert_eq!(f.engine.pending(), Some(VecDeque::from([first, last])));
        assert_eq!(f.engine.store.position(&key()), Some(&cursor()));
        assert!(f.engine.store.is_seen(&key(), shared.id()));
        assert_eq!(
            f.engine.store.pending(&other),
            Some(&VecDeque::from([shared]))
        );
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
        assert_eq!(f.engine.pending(), Some(VecDeque::from(initial)));
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
        assert_eq!(reopened.pending(&key()), Some(&VecDeque::from(events)));
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

    struct CountingStore {
        inner: Store,
        commits: Arc<AtomicUsize>,
        acks: Arc<AtomicUsize>,
    }

    impl StateStore for CountingStore {
        fn position(&self, key: &PositionKey) -> Option<Position> {
            StateStore::position(&self.inner, key)
        }

        fn is_seen(&self, key: &PositionKey, id: &EventId) -> bool {
            StateStore::is_seen(&self.inner, key, id)
        }

        fn pending(&self, key: &PositionKey) -> Option<VecDeque<Event>> {
            StateStore::pending(&self.inner, key)
        }

        fn ack_pending(
            &mut self,
            key: &PositionKey,
            ids: &[EventId],
        ) -> Result<usize, StoreError> {
            self.acks.fetch_add(1, Ordering::Relaxed);
            StateStore::ack_pending(&mut self.inner, key, ids)
        }

        fn commit(
            &mut self,
            key: PositionKey,
            position: Position,
            events: &[Event],
        ) -> Result<usize, StoreError> {
            self.commits.fetch_add(1, Ordering::Relaxed);
            StateStore::commit(&mut self.inner, key, position, events)
        }
    }

    #[test]
    fn an_injected_store_receives_commits_and_acknowledgements() {
        let dir = tempfile::tempdir().unwrap();
        let commits = Arc::new(AtomicUsize::new(0));
        let acks = Arc::new(AtomicUsize::new(0));
        let store = CountingStore {
            inner: Store::open(dir.path()).unwrap(),
            commits: commits.clone(),
            acks: acks.clone(),
        };
        let clock = Arc::new(FakeClock::default());
        let fired = event("fired");
        let outcome =
            PollOutcome::new(vec![fired.clone()], cursor(), Next::Done).unwrap();
        let source = Arc::new(FakeSource {
            name: timer(),
            results: Mutex::new(VecDeque::from([Ok(outcome)])),
            requests: Mutex::new(Vec::new()),
        });
        let config = MonitorConfig {
            id: key().monitor,
            source: timer(),
            poll_interval: PollInterval::from_secs(5).unwrap(),
        };
        let mut engine = PollEngine::new(config, source, store, clock).unwrap();

        assert_eq!(engine.run(1).unwrap(), EngineState::Ended);
        assert_eq!(commits.load(Ordering::Relaxed), 1);
        assert_eq!(acks.load(Ordering::Relaxed), 0);
        assert_eq!(engine.pending(), Some(VecDeque::from([fired.clone()])));

        assert_eq!(engine.ack(std::slice::from_ref(fired.id())).unwrap(), 1);
        assert_eq!(commits.load(Ordering::Relaxed), 1);
        assert_eq!(acks.load(Ordering::Relaxed), 1);
        assert_eq!(engine.pending(), Some(VecDeque::new()));
    }
}
