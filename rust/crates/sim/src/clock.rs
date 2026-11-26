//! A clock whose time moves only when the simulation moves it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_core::{Clock, ClockError};

/// One scripted reading, in place of the virtual time a clock would report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClockFault {
    /// Report the current virtual time.
    Ok,
    /// Report a reading before the representable range.
    Past,
    /// Report a reading after the representable range.
    Future,
}

impl ClockFault {
    const fn as_error(self) -> Option<ClockError> {
        match self {
            Self::Ok => None,
            Self::Past => Some(ClockError::Past),
            Self::Future => Some(ClockError::Future),
        }
    }
}

/// A virtual clock with scripted readings and a log of requested sleeps.
#[derive(Debug)]
pub struct SimClock {
    now: Mutex<Timestamp>,
    faults: Mutex<VecDeque<ClockFault>>,
    consumed: Arc<AtomicUsize>,
    sleeps: Mutex<Vec<Duration>>,
}

impl SimClock {
    /// Starts at `start` with no scripted faults or sleeps.
    #[must_use]
    pub fn new(start: Timestamp) -> Self {
        Self {
            now: Mutex::new(start),
            faults: Mutex::new(VecDeque::new()),
            consumed: Arc::new(AtomicUsize::new(0)),
            sleeps: Mutex::new(Vec::new()),
        }
    }

    /// Adds one scripted reading to the front of the queue.
    pub fn script(&self, fault: ClockFault) {
        self.faults
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(fault);
    }

    /// Returns the number of scripted readings consumed so far.
    #[must_use]
    pub fn fault_count(&self) -> usize {
        self.consumed.load(Ordering::Relaxed)
    }

    /// Returns virtual time without consuming a scripted reading.
    #[must_use]
    pub fn virtual_now(&self) -> Timestamp {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Advances virtual time by `seconds` without recording a sleep.
    pub fn advance(&self, seconds: u64) {
        let next = self.advanced(Duration::from_secs(seconds));

        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = next;
    }

    /// Advances virtual time by a requested sleep and logs the duration.
    fn slept(&self, duration: Duration) {
        let next = self.advanced(duration);

        self.sleeps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(duration);
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = next;
    }

    /// Virtual time never passes the last representable timestamp.
    fn advanced(&self, duration: Duration) -> Timestamp {
        self.virtual_now()
            .checked_add(duration)
            .unwrap_or(Timestamp::MAX)
    }

    /// Returns a copy of the sleeps in the order they were requested.
    #[must_use]
    pub fn sleep_log(&self) -> Vec<Duration> {
        self.sleeps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Clock for SimClock {
    fn now(&self) -> Result<Timestamp, ClockError> {
        let fault = self
            .faults
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();

        if let Some(fault) = fault {
            self.consumed.fetch_add(1, Ordering::Relaxed);

            if let Some(error) = fault.as_error() {
                return Err(error);
            }
        }

        Ok(self.virtual_now())
    }

    fn sleep(&self, duration: Duration) {
        self.slept(duration);
    }
}
#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use sourcefed_core::ClockError;

    use super::*;

    #[test]
    fn scripted_readings_are_consumed_in_order() {
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        clock.script(ClockFault::Ok);
        clock.script(ClockFault::Past);
        clock.script(ClockFault::Future);

        assert_eq!(clock.fault_count(), 0);
        assert_eq!(clock.now(), Ok(Timestamp::UNIX_EPOCH));
        assert_eq!(clock.now(), Err(ClockError::Past));
        assert_eq!(clock.now(), Err(ClockError::Future));
        assert_eq!(clock.fault_count(), 3);
        assert_eq!(clock.now(), Ok(Timestamp::UNIX_EPOCH));
        assert_eq!(clock.fault_count(), 3);
    }

    #[test]
    fn sleeps_and_advances_move_virtual_time() {
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        clock.advance(5);
        clock.sleep(Duration::from_secs(3));

        let expected = Timestamp::UNIX_EPOCH
            .checked_add(Duration::from_secs(8))
            .unwrap();

        assert_eq!(clock.virtual_now(), expected);
        assert_eq!(clock.sleep_log(), vec![Duration::from_secs(3)]);
    }

    #[test]
    fn an_oversized_advance_clamps_to_the_last_timestamp() {
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        clock.advance(u64::MAX);

        assert_eq!(clock.virtual_now(), Timestamp::MAX);
    }
}
