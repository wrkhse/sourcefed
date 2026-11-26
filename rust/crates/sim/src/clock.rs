//! A virtual clock whose readings and sleeps never touch the wall clock.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_core::{Clock, ClockError};

/// The out-of-range reading a scripted step returns.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ClockFault {
    /// Reports `ClockError::Past` instead of a reading.
    Past,
    /// Reports `ClockError::Future` instead of a reading.
    Future,
}

impl From<ClockFault> for ClockError {
    fn from(fault: ClockFault) -> Self {
        match fault {
            ClockFault::Past => Self::Past,
            ClockFault::Future => Self::Future,
        }
    }
}

/// A clock advanced only by scripted readings and simulated sleeps.
///
/// Readings are consumed in the order they are scripted. Once the script is
/// empty, a reading is the current virtual time. A fault never moves that time;
/// a sleep moves it by the requested duration and is recorded without blocking.
/// Each part has its own lock so poisoning one is observable on its own.
#[derive(Debug)]
pub struct SimClock {
    now: Mutex<Timestamp>,
    readings: Mutex<VecDeque<Result<Timestamp, ClockFault>>>,
    sleeps: Mutex<Vec<Duration>>,
    faults: Mutex<u64>,
}

impl SimClock {
    /// Starts at `start` with no scripted readings or sleeps.
    #[must_use]
    pub const fn new(start: Timestamp) -> Self {
        Self {
            now: Mutex::new(start),
            readings: Mutex::new(VecDeque::new()),
            sleeps: Mutex::new(Vec::new()),
            faults: Mutex::new(0),
        }
    }

    /// Appends one reading to the script; readings are consumed in order.
    pub fn script(&self, reading: Result<Timestamp, ClockFault>) {
        // A poisoned queue accepts nothing more; `now` fails closed instead.
        if let Ok(mut readings) = self.readings.lock() {
            readings.push_back(reading);
        }
    }

    /// Returns the current virtual instant.
    #[must_use]
    pub fn virtual_now(&self) -> Timestamp {
        // Invariant: a poisoned time lock is untrustworthy, so report the
        // maximum timestamp as an unmistakable out-of-range sentinel.
        self.now.lock().ok().map_or(Timestamp::MAX, |now| *now)
    }

    /// Returns every simulated sleep in the order it happened.
    #[must_use]
    pub fn sleep_log(&self) -> Vec<Duration> {
        // Invariant: a poisoned log reads as empty, so time moving without a
        // logged sleep is visible to the checker.
        self.sleeps
            .lock()
            .ok()
            .map_or_else(Vec::new, |sleeps| sleeps.clone())
    }

    /// Returns how many scripted faults have been consumed.
    #[must_use]
    pub fn fault_count(&self) -> u64 {
        // Invariant: a poisoned counter is unavailable, so report u64::MAX
        // (usize::MAX on this platform) instead of a plausible count.
        self.faults.lock().ok().map_or(u64::MAX, |faults| *faults)
    }

    fn set_now(&self, at: Timestamp) {
        if let Ok(mut now) = self.now.lock() {
            *now = at;
        }
    }

    fn count_fault(&self) {
        if let Ok(mut faults) = self.faults.lock() {
            *faults = faults.saturating_add(1);
        }
    }
}

impl Clock for SimClock {
    fn now(&self) -> Result<Timestamp, ClockError> {
        let Ok(mut readings) = self.readings.lock() else {
            // Invariant: a poisoned fault queue fails closed, so the engine
            // stops rather than reading possibly inconsistent clock state.
            return Err(ClockError::Past);
        };

        let reading = readings.pop_front();
        drop(readings);

        let Some(reading) = reading else {
            // Invariant: a poisoned time lock fails closed, so an unscripted
            // reading reports an error instead of the MAX sentinel.
            if self.now.lock().is_err() {
                return Err(ClockError::Past);
            }
            return Ok(self.virtual_now());
        };

        match reading {
            Ok(at) => {
                self.set_now(at);

                Ok(at)
            }
            Err(fault) => {
                self.count_fault();

                Err(fault.into())
            }
        }
    }

    fn sleep(&self, duration: Duration) {
        // Invariant: a poisoned time lock fails closed; no duration is
        // applied and none is logged for a sleep that never moved time.
        let Ok(mut now) = self.now.lock() else {
            return;
        };
        *now = now.checked_add(duration).unwrap_or(Timestamp::MAX);
        drop(now);

        // Invariant: a poisoned log is skipped, but virtual time still moves,
        // so the checker sees time move without a logged sleep.
        if let Ok(mut sleeps) = self.sleeps.lock() {
            sleeps.push(duration);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn at(secs: i64) -> Timestamp {
        Timestamp::new(secs, 0).unwrap()
    }

    // join() is the catch_unwind boundary: the helper panics while holding
    // the guard, so the mutex stays poisoned for the caller's accessors.
    fn poison_with(
        clock: &Arc<SimClock>,
        hold: impl FnOnce(Arc<SimClock>) + Send + 'static,
    ) {
        let thread_clock = Arc::clone(clock);
        let outcome = std::thread::spawn(move || hold(thread_clock)).join();

        assert!(outcome.is_err());
    }

    fn poison_readings(clock: &Arc<SimClock>) {
        poison_with(clock, |clock| {
            let _guard = clock.readings.lock().unwrap();
            panic!("poison the fault queue");
        });
    }

    fn poison_time(clock: &Arc<SimClock>) {
        poison_with(clock, |clock| {
            let _guard = clock.now.lock().unwrap();
            panic!("poison the time lock");
        });
    }

    fn poison_sleeps(clock: &Arc<SimClock>) {
        poison_with(clock, |clock| {
            let _guard = clock.sleeps.lock().unwrap();
            panic!("poison the sleep log");
        });
    }

    fn poison_faults(clock: &Arc<SimClock>) {
        poison_with(clock, |clock| {
            let _guard = clock.faults.lock().unwrap();
            panic!("poison the fault counter");
        });
    }

    #[test]
    fn scripted_readings_are_consumed_in_order() {
        let clock = SimClock::new(at(0));
        clock.script(Ok(at(5)));
        clock.script(Err(ClockFault::Past));
        clock.script(Ok(at(10)));

        assert_eq!(clock.now(), Ok(at(5)));
        assert_eq!(clock.now(), Err(ClockError::Past));
        assert_eq!(clock.now(), Ok(at(10)));
        assert_eq!(clock.now(), Ok(at(10)));
        assert_eq!(clock.virtual_now(), at(10));
        assert_eq!(clock.fault_count(), 1);
    }

    #[test]
    fn a_future_fault_is_reported_without_moving_the_clock() {
        let clock = SimClock::new(at(7));
        clock.script(Err(ClockFault::Future));

        assert_eq!(clock.now(), Err(ClockError::Future));
        assert_eq!(clock.now(), Ok(at(7)));
        assert_eq!(clock.virtual_now(), at(7));
        assert_eq!(clock.fault_count(), 1);
    }

    #[test]
    fn sleeps_advance_virtual_time_and_are_logged_without_blocking() {
        let clock = SimClock::new(at(0));
        clock.sleep(Duration::from_secs(5));
        clock.sleep(Duration::from_millis(250));

        assert_eq!(
            clock.sleep_log(),
            [Duration::from_secs(5), Duration::from_millis(250)]
        );
        assert_eq!(clock.virtual_now(), Timestamp::new(5, 250_000_000).unwrap());
        assert_eq!(clock.now(), Ok(clock.virtual_now()));
        assert_eq!(clock.fault_count(), 0);
    }

    #[test]
    fn a_sleep_past_the_range_saturates_at_the_maximum() {
        let clock = SimClock::new(Timestamp::MAX);
        clock.sleep(Duration::MAX);

        assert_eq!(clock.sleep_log(), [Duration::MAX]);
        assert_eq!(clock.virtual_now(), Timestamp::MAX);
    }

    #[test]
    fn a_poisoned_fault_queue_fails_closed() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_readings(&clock);

        assert_eq!(clock.now(), Err(ClockError::Past));
        assert_eq!(clock.virtual_now(), at(0));
    }

    #[test]
    fn a_poisoned_time_lock_reports_the_maximum_timestamp() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_time(&clock);

        assert_eq!(clock.virtual_now(), Timestamp::MAX);
    }

    #[test]
    fn a_poisoned_time_lock_fails_closed_on_reading() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_time(&clock);

        assert_eq!(clock.now(), Err(ClockError::Past));
    }

    #[test]
    fn a_poisoned_time_lock_does_not_log_a_sleep() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_time(&clock);
        clock.sleep(Duration::from_secs(5));

        assert_eq!(clock.sleep_log(), Vec::<Duration>::new());
        assert_eq!(clock.virtual_now(), Timestamp::MAX);
    }

    #[test]
    fn a_poisoned_sleep_log_moves_time_without_a_log_entry() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_sleeps(&clock);
        clock.sleep(Duration::from_secs(5));

        assert_eq!(clock.virtual_now(), at(5));
        assert_eq!(clock.sleep_log(), Vec::<Duration>::new());
    }

    #[test]
    fn a_poisoned_counter_reports_an_unavailable_sentinel() {
        let clock = Arc::new(SimClock::new(at(0)));
        poison_faults(&clock);

        assert_eq!(clock.fault_count(), u64::MAX);
    }
}
