//! A deterministic trace driven by a seed, a clock and a store.
//!
//! Replaying the same seed and step count always records the same steps and
//! the same hash, with no engine, process, wall clock or operating-system
//! randomness involved.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_core::{
    Clock, ClockError, Event, EventId, EventKind, EventSubject, MonitorId, Position,
    PositionKey, SourceName, StateStore,
};

use crate::{ClockFault, MemoryStore, Seed, SimClock};

/// One step recorded by a replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Step {
    /// A clock reading at a virtual instant.
    Reading(Timestamp),
    /// A scripted clock fault returned instead of a reading.
    Fault(ClockFault),
    /// A sleep that advanced virtual time without blocking.
    Sleep(Duration),
    /// A commit with the saved position and the number of fresh events.
    Commit {
        /// The position text saved by the commit.
        position: String,
        /// How many events were new for the key.
        fresh: usize,
    },
    /// An acknowledgement with the event ID and how many events it removed.
    Ack {
        /// The ID offered to the store.
        id: String,
        /// How many pending events were removed.
        removed: usize,
    },
}

/// The ordered steps recorded by one replay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trace {
    seed: Seed,
    steps: Vec<Step>,
}

impl Trace {
    /// Starts an empty trace for `seed`.
    #[must_use]
    pub const fn new(seed: Seed) -> Self {
        Self {
            seed,
            steps: Vec::new(),
        }
    }

    /// Returns the seed that drives this trace.
    #[must_use]
    pub const fn seed(&self) -> Seed {
        self.seed
    }

    /// Returns the recorded steps in order.
    #[must_use]
    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    /// Appends one step to the trace.
    pub fn push(&mut self, step: Step) {
        self.steps.push(step);
    }

    /// Hashes the seed and every recorded step in order.
    ///
    /// The hasher has fixed keys, so the result is stable across runs.
    #[must_use]
    pub fn hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.seed.hash(&mut hasher);

        for step in &self.steps {
            hash_step(step, &mut hasher);
        }

        hasher.finish()
    }
}

fn hash_step(step: &Step, hasher: &mut DefaultHasher) {
    match step {
        Step::Reading(at) => {
            0_u8.hash(hasher);
            at.as_second().hash(hasher);
            at.subsec_nanosecond().hash(hasher);
        }
        Step::Fault(fault) => {
            1_u8.hash(hasher);
            fault.hash(hasher);
        }
        Step::Sleep(duration) => {
            2_u8.hash(hasher);
            duration.as_secs().hash(hasher);
            duration.subsec_nanos().hash(hasher);
        }
        Step::Commit { position, fresh } => {
            3_u8.hash(hasher);
            position.hash(hasher);
            fresh.hash(hasher);
        }
        Step::Ack { id, removed } => {
            4_u8.hash(hasher);
            id.hash(hasher);
            removed.hash(hasher);
        }
    }
}

/// Drives the seed, clock and store through `steps` deterministic steps.
///
/// Each step takes one draw for the reading, sleeps for a seeded duration,
/// commits one seeded event and acknowledges that event every third step.
#[must_use]
pub fn replay(mut seed: Seed, steps: u32) -> Trace {
    let mut trace = Trace::new(seed);
    let clock = SimClock::new(Timestamp::UNIX_EPOCH);
    let mut store = MemoryStore::new();
    let key = replay_key();

    let Some(key) = key else {
        return trace;
    };

    for index in 0..steps {
        let draw = seed.next_u64();
        script_reading(&clock, draw);

        match clock.now() {
            Ok(at) => trace.push(Step::Reading(at)),
            Err(error) => trace.push(Step::Fault(fault_of(error))),
        }

        let duration = Duration::from_millis(seed.below(10_000));
        clock.sleep(duration);
        trace.push(Step::Sleep(duration));

        let Some(event) =
            next_event(&mut seed, &key.source, clock.virtual_now(), index)
        else {
            continue;
        };
        let position_text = format!("step-{index}-{draw}");
        let Ok(position) = Position::new(position_text.clone()) else {
            continue;
        };

        let fresh = store
            .commit(key.clone(), position, std::slice::from_ref(&event))
            .unwrap_or(0);
        trace.push(Step::Commit {
            position: position_text,
            fresh,
        });

        if index.checked_rem(3).unwrap_or(0) == 0 {
            let removed = store
                .ack_pending(&key, std::slice::from_ref(event.id()))
                .unwrap_or(0);
            trace.push(Step::Ack {
                id: String::from(event.id().as_str()),
                removed,
            });
        }
    }

    trace
}

fn replay_key() -> Option<PositionKey> {
    let source = SourceName::new("sim".into()).ok()?;
    let monitor = MonitorId::new("replay".into()).ok()?;

    Some(PositionKey { monitor, source })
}

fn script_reading(clock: &SimClock, draw: u64) {
    if draw.checked_rem(5).unwrap_or(0) == 0 {
        let fault = if draw.checked_rem(2).unwrap_or(0) == 0 {
            ClockFault::Past
        } else {
            ClockFault::Future
        };

        clock.script(Err(fault));
    } else {
        clock.script(Ok(clock.virtual_now()));
    }
}

const fn fault_of(error: ClockError) -> ClockFault {
    match error {
        ClockError::Past => ClockFault::Past,
        ClockError::Future => ClockFault::Future,
    }
}

fn next_event(
    seed: &mut Seed,
    source: &SourceName,
    now: Timestamp,
    index: u32,
) -> Option<Event> {
    let subject = EventSubject::new(source.clone(), "step".into()).ok()?;
    let id = EventId::new(format!("sim-{index}-{}", seed.below(1_000_000))).ok()?;

    Event::new(id, EventKind::TimerFired, subject, "replay".into(), now).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_records_the_same_steps_and_hash() {
        let first = replay(Seed::from_u64(42), 5);
        let second = replay(Seed::from_u64(42), 5);

        assert_eq!(first.steps(), second.steps());
        assert_eq!(first.hash(), second.hash());
        assert_ne!(first.hash(), replay(Seed::from_u64(43), 5).hash());
    }

    #[test]
    fn each_step_records_a_reading_a_sleep_and_a_commit() {
        let trace = replay(Seed::from_u64(3), 5);
        let steps = trace.steps();
        let count = |variant: fn(&Step) -> bool| {
            steps.iter().filter(|step| variant(step)).count()
        };

        assert_eq!(steps[0], Step::Reading(Timestamp::UNIX_EPOCH));
        assert_eq!(steps.len(), 17);
        assert_eq!(count(|step| matches!(step, Step::Reading(_))), 5);
        assert_eq!(count(|step| matches!(step, Step::Fault(_))), 0);
        assert_eq!(count(|step| matches!(step, Step::Sleep(_))), 5);
        assert_eq!(count(|step| matches!(step, Step::Commit { .. })), 5);
        assert_eq!(count(|step| matches!(step, Step::Ack { .. })), 2);
        assert_eq!(trace.seed(), Seed::from_u64(3));
    }

    #[test]
    fn a_scripted_fault_is_recorded_instead_of_a_reading() {
        let future = replay(Seed::from_u64(1), 1);

        assert_eq!(future.steps()[0], Step::Fault(ClockFault::Future));
        assert_eq!(future.steps()[1], Step::Sleep(Duration::from_millis(8519)));
        assert_eq!(future.steps().len(), 4);
        assert_eq!(
            future.steps()[3],
            Step::Ack {
                id: String::from("sim-0-890590"),
                removed: 1
            }
        );

        let past = replay(Seed::from_u64(2), 1);

        assert_eq!(past.steps()[0], Step::Fault(ClockFault::Past));
        assert_ne!(past.hash(), future.hash());
    }

    #[test]
    fn zero_steps_records_nothing_but_keeps_the_seed_in_the_hash() {
        let trace = replay(Seed::from_u64(7), 0);

        assert_eq!(trace.steps(), &[]);
        assert_eq!(trace.hash(), replay(Seed::from_u64(7), 0).hash());
        assert_ne!(trace.hash(), replay(Seed::from_u64(8), 0).hash());
    }

    #[test]
    fn a_pushed_step_changes_the_trace_and_its_hash() {
        let mut trace = Trace::new(Seed::from_u64(7));
        let empty = trace.hash();
        let reading = Step::Reading(Timestamp::UNIX_EPOCH);
        trace.push(reading.clone());

        assert_eq!(trace.seed(), Seed::from_u64(7));
        assert_eq!(trace.steps(), &[reading]);
        assert_ne!(trace.hash(), empty);
    }
}
