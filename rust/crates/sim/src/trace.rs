//! A deterministic trace driven by a seed, a clock and a store.
//!
//! Replaying the same seed and step count always records the same steps and
//! the same hash, with no engine, process, wall clock or operating-system
//! randomness involved.

use std::fmt;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_core::{
    Clock, ClockError, Event, EventId, EventKind, EventSubject, MonitorId, Position,
    PositionKey, SourceName, StateStore,
};

use crate::{ClockFault, MemoryStore, Seed, SimClock, StoreControl};

const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
const FNV_PRIME: u64 = 1_099_511_628_211;

// Long replays arm both scripted store writes at fixed steps. The ack step
// is a multiple of three, so an acknowledgement follows that commit.
const COMMIT_FAULT_STEP: u32 = 6;
const ACK_FAULT_STEP: u32 = 9;

// `DefaultHasher` may change its algorithm between Rust releases, so traces
// use FNV-1a to keep recorded hashes stable across builds.
struct FnvHasher(u64);

impl Default for FnvHasher {
    fn default() -> Self {
        Self(FNV_OFFSET)
    }
}

impl Hasher for FnvHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
    }

    fn write_u8(&mut self, value: u8) {
        self.write(&value.to_le_bytes());
    }

    fn write_u16(&mut self, value: u16) {
        self.write(&value.to_le_bytes());
    }

    fn write_u32(&mut self, value: u32) {
        self.write(&value.to_le_bytes());
    }

    fn write_u64(&mut self, value: u64) {
        self.write(&value.to_le_bytes());
    }

    fn write_u128(&mut self, value: u128) {
        self.write(&value.to_le_bytes());
    }

    fn write_usize(&mut self, value: usize) {
        let wide = u64::try_from(value).unwrap_or(u64::MAX);
        self.write(&wide.to_le_bytes());
    }

    fn write_i8(&mut self, value: i8) {
        self.write(&value.to_le_bytes());
    }

    fn write_i16(&mut self, value: i16) {
        self.write(&value.to_le_bytes());
    }

    fn write_i32(&mut self, value: i32) {
        self.write(&value.to_le_bytes());
    }

    fn write_i64(&mut self, value: i64) {
        self.write(&value.to_le_bytes());
    }

    fn write_i128(&mut self, value: i128) {
        self.write(&value.to_le_bytes());
    }

    fn write_isize(&mut self, value: isize) {
        let wide = i64::try_from(value).unwrap_or(i64::MAX);
        self.write(&wide.to_le_bytes());
    }
}

/// A setup failure that stops a replay before it records a step.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayError {
    /// The fixed position key could not be built.
    Key,
    /// A step's event could not be built.
    Event,
    /// A step's position could not be built.
    Position,
}

impl fmt::Display for ReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Key => formatter.write_str("invalid replay key"),
            Self::Event => formatter.write_str("invalid replay event"),
            Self::Position => formatter.write_str("invalid replay position"),
        }
    }
}

impl std::error::Error for ReplayError {}

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
    /// A commit refused by the store, with the error message.
    CommitFault(String),
    /// An acknowledgement with the event ID and how many events it removed.
    Ack {
        /// The ID offered to the store.
        id: String,
        /// How many pending events were removed.
        removed: usize,
    },
    /// An acknowledgement refused by the store, with the error message.
    AckFault(String),
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
    /// The hasher has fixed FNV-1a constants, so the result is stable
    /// across runs and Rust releases.
    #[must_use]
    pub fn hash(&self) -> u64 {
        let mut hasher = FnvHasher::default();
        self.seed.hash(&mut hasher);

        for step in &self.steps {
            hash_step(step, &mut hasher);
        }

        hasher.finish()
    }
}

fn hash_step(step: &Step, hasher: &mut FnvHasher) {
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
        Step::CommitFault(message) => {
            5_u8.hash(hasher);
            message.hash(hasher);
        }
        Step::AckFault(message) => {
            6_u8.hash(hasher);
            message.hash(hasher);
        }
    }
}

/// Drives the seed, clock and store through `steps` deterministic steps.
///
/// Each step takes one draw for the reading, sleeps for a seeded duration,
/// commits one seeded event and acknowledges that event every third step.
///
/// # Errors
///
/// Returns an error when the key, an event or a position cannot be built,
/// rather than recording a shorter trace that looks successful.
pub fn replay(seed: Seed, steps: u32) -> Result<Trace, ReplayError> {
    replay_with(seed, steps, replay_key())
}

// The key arrives as a result so a failed setup is returned, never hidden
// behind an empty trace.
fn replay_with(
    mut seed: Seed,
    steps: u32,
    key: Result<PositionKey, ReplayError>,
) -> Result<Trace, ReplayError> {
    let key = key?;
    let mut trace = Trace::new(seed);
    let clock = SimClock::new(Timestamp::UNIX_EPOCH);
    let mut store = MemoryStore::new();

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

        let event = next_event(&mut seed, &key.source, clock.virtual_now(), index)?;
        let position_text = format!("step-{index}-{draw}");
        let position = Position::new(position_text.clone())
            .map_err(|_| ReplayError::Position)?;

        if index == COMMIT_FAULT_STEP {
            store.script(StoreControl::CommitFault);
        }

        let commit = match store.commit(
            key.clone(),
            position,
            std::slice::from_ref(&event),
        ) {
            Ok(fresh) => Step::Commit {
                position: position_text,
                fresh,
            },
            Err(error) => Step::CommitFault(error.to_string()),
        };
        trace.push(commit);

        if index.checked_rem(3).unwrap_or(0) == 0 {
            if index == ACK_FAULT_STEP {
                store.script(StoreControl::AckFault);
            }

            let ack = match store.ack_pending(&key, std::slice::from_ref(event.id()))
            {
                Ok(removed) => Step::Ack {
                    id: String::from(event.id().as_str()),
                    removed,
                },
                Err(error) => Step::AckFault(error.to_string()),
            };
            trace.push(ack);
        }
    }

    Ok(trace)
}

fn replay_key() -> Result<PositionKey, ReplayError> {
    let source = SourceName::new("sim".into()).map_err(|_| ReplayError::Key)?;
    let monitor = MonitorId::new("replay".into()).map_err(|_| ReplayError::Key)?;

    Ok(PositionKey { monitor, source })
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
) -> Result<Event, ReplayError> {
    let subject = EventSubject::new(source.clone(), "step".into())
        .map_err(|_| ReplayError::Event)?;
    let id = EventId::new(format!("sim-{index}-{}", seed.below(1_000_000)))
        .map_err(|_| ReplayError::Event)?;

    Event::new(id, EventKind::TimerFired, subject, "replay".into(), now)
        .map_err(|_| ReplayError::Event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sourcefed_core::{MAX_PENDING_EVENTS, StoreError};

    #[test]
    fn the_same_seed_records_the_same_steps_and_hash() {
        let first = replay(Seed::from_u64(42), 5).unwrap();
        let second = replay(Seed::from_u64(42), 5).unwrap();

        assert_eq!(first.steps(), second.steps());
        assert_eq!(first.hash(), second.hash());
        assert_ne!(first.hash(), replay(Seed::from_u64(43), 5).unwrap().hash());
    }

    #[test]
    fn each_step_records_a_reading_a_sleep_and_a_commit() {
        let trace = replay(Seed::from_u64(3), 5).unwrap();
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
        let future = replay(Seed::from_u64(1), 1).unwrap();

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

        let past = replay(Seed::from_u64(2), 1).unwrap();

        assert_eq!(past.steps()[0], Step::Fault(ClockFault::Past));
        assert_ne!(past.hash(), future.hash());
    }

    #[test]
    fn zero_steps_records_nothing_but_keeps_the_seed_in_the_hash() {
        let trace = replay(Seed::from_u64(7), 0).unwrap();

        assert_eq!(trace.steps(), &[]);
        assert_eq!(trace.hash(), replay(Seed::from_u64(7), 0).unwrap().hash());
        assert_ne!(trace.hash(), replay(Seed::from_u64(8), 0).unwrap().hash());
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

    #[test]
    fn a_full_pending_queue_records_a_commit_fault() {
        let steps =
            u32::try_from(MAX_PENDING_EVENTS.saturating_mul(2)).unwrap_or_default();
        let trace = replay(Seed::from_u64(3), steps).unwrap();
        let expected = Step::CommitFault(
            StoreError::TooMany {
                limit: MAX_PENDING_EVENTS,
            }
            .to_string(),
        );
        let last =
            trace.steps().iter().rev().find(|step| {
                matches!(step, Step::Commit { .. } | Step::CommitFault(_))
            });

        assert_eq!(last, Some(&expected));
        assert_eq!(
            trace
                .steps()
                .iter()
                .filter(|step| matches!(step, Step::Commit { fresh: 0, .. }))
                .count(),
            0
        );
    }

    // Reading, sleep and commit precede each step; every third step also
    // acknowledges, so earlier acks shift the position of a later fault.
    fn fault_offset(index: u32, ack: bool) -> usize {
        let earlier = usize::try_from(index).unwrap_or_default();
        let before = earlier
            .saturating_mul(3)
            .saturating_add(earlier.div_ceil(3));

        before.saturating_add(if ack { 3 } else { 2 })
    }

    #[test]
    fn scripted_store_faults_are_recorded_at_deterministic_steps() {
        let trace = replay(Seed::from_u64(3), 10).unwrap();
        let steps = trace.steps();
        let commit_at = fault_offset(COMMIT_FAULT_STEP, false);
        let ack_at = fault_offset(ACK_FAULT_STEP, true);
        let count = |variant: fn(&Step) -> bool| {
            steps.iter().filter(|step| variant(step)).count()
        };

        assert_eq!(
            steps[commit_at],
            Step::CommitFault(String::from(
                "could not write sim: scripted commit fault"
            ))
        );
        assert_eq!(
            steps[ack_at],
            Step::AckFault(String::from("could not write sim: scripted ack fault"))
        );
        assert_eq!(
            steps
                .iter()
                .position(|step| matches!(step, Step::CommitFault(_))),
            Some(commit_at)
        );
        assert_eq!(
            steps
                .iter()
                .position(|step| matches!(step, Step::AckFault(_))),
            Some(ack_at)
        );
        assert_eq!(steps.len(), 34);
        assert_eq!(count(|step| matches!(step, Step::Reading(_))), 10);
        assert_eq!(count(|step| matches!(step, Step::Sleep(_))), 10);
        assert_eq!(count(|step| matches!(step, Step::Commit { .. })), 9);
        assert_eq!(count(|step| matches!(step, Step::Ack { .. })), 3);
    }

    #[test]
    fn store_faults_hash_differ_from_successful_steps() {
        let seed = Seed::from_u64(3);
        let trace = replay(seed, 10).unwrap();
        let mut successful = Trace::new(seed);

        for step in trace.steps() {
            let clean = match step {
                Step::CommitFault(message) => Step::Commit {
                    position: message.clone(),
                    fresh: 1,
                },
                Step::AckFault(message) => Step::Ack {
                    id: message.clone(),
                    removed: 1,
                },
                other => other.clone(),
            };
            successful.push(clean);
        }

        assert_ne!(trace.hash(), successful.hash());

        let message = String::from("could not write sim: scripted commit fault");
        let mut commit_ok = Trace::new(seed);
        let mut commit_bad = Trace::new(seed);
        commit_ok.push(Step::Commit {
            position: message.clone(),
            fresh: 1,
        });
        commit_bad.push(Step::CommitFault(message));
        assert_ne!(commit_bad.hash(), commit_ok.hash());

        let message = String::from("could not write sim: scripted ack fault");
        let mut ack_ok = Trace::new(seed);
        let mut ack_bad = Trace::new(seed);
        ack_ok.push(Step::Ack {
            id: message.clone(),
            removed: 1,
        });
        ack_bad.push(Step::AckFault(message));
        assert_ne!(ack_bad.hash(), ack_ok.hash());
    }

    #[test]
    fn a_failed_setup_is_returned_instead_of_a_successful_trace() {
        let result = replay_with(Seed::from_u64(3), 5, Err(ReplayError::Key));

        assert_eq!(result, Err(ReplayError::Key));
        assert_eq!(ReplayError::Key.to_string(), "invalid replay key");
        assert_eq!(ReplayError::Event.to_string(), "invalid replay event");
        assert_eq!(ReplayError::Position.to_string(), "invalid replay position");
    }

    #[test]
    fn the_hash_is_a_pinned_fnv_1a_value() {
        let mut trace = Trace::new(Seed::from_u64(1));
        trace.push(Step::Reading(Timestamp::UNIX_EPOCH));

        assert_eq!(trace.hash(), 0x0F36_9EF7_383E_59EC);
    }
}
