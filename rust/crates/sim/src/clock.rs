//! A virtual clock whose readings and sleeps never touch the wall clock.

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
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

#[derive(Debug)]
struct ClockState {
    now: Timestamp,
    readings: VecDeque<Result<Timestamp, ClockFault>>,
    sleeps: Vec<Duration>,
    faults: u64,
}

/// A clock advanced only by scripted readings and simulated sleeps.
///
/// Readings are consumed in the order they are scripted. Once the script is
/// empty, a reading is the current virtual time. A fault never moves that time;
/// a sleep moves it by the requested duration and is recorded without blocking.
#[derive(Debug)]
pub struct SimClock {
    state: Mutex<ClockState>,
}

impl SimClock {
    /// Starts at `start` with no scripted readings or sleeps.
    #[must_use]
    pub const fn new(start: Timestamp) -> Self {
        let state = ClockState {
            now: start,
            readings: VecDeque::new(),
            sleeps: Vec::new(),
            faults: 0,
        };

        Self {
            state: Mutex::new(state),
        }
    }

    /// Appends one reading to the script; readings are consumed in order.
    pub fn script(&self, reading: Result<Timestamp, ClockFault>) {
        self.lock().readings.push_back(reading);
    }

    /// Returns the current virtual instant.
    #[must_use]
    pub fn virtual_now(&self) -> Timestamp {
        self.lock().now
    }

    /// Returns every simulated sleep in the order it happened.
    #[must_use]
    pub fn sleep_log(&self) -> Vec<Duration> {
        self.lock().sleeps.clone()
    }

    /// Returns how many scripted faults have been consumed.
    #[must_use]
    pub fn fault_count(&self) -> u64 {
        self.lock().faults
    }

    // A poisoned lock still holds the last committed state, so retry using it.
    fn lock(&self) -> MutexGuard<'_, ClockState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl ClockState {
    fn reading(&mut self) -> Result<Timestamp, ClockError> {
        let Some(reading) = self.readings.pop_front() else {
            return Ok(self.now);
        };

        match reading {
            Ok(at) => {
                self.now = at;

                Ok(at)
            }
            Err(fault) => {
                self.faults = self.faults.saturating_add(1);

                Err(fault.into())
            }
        }
    }
}

impl Clock for SimClock {
    fn now(&self) -> Result<Timestamp, ClockError> {
        self.lock().reading()
    }

    fn sleep(&self, duration: Duration) {
        let mut state = self.lock();
        state.sleeps.push(duration);
        state.now = state.now.checked_add(duration).unwrap_or(Timestamp::MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> Timestamp {
        Timestamp::new(secs, 0).unwrap()
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
}
