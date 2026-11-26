//! A seeded simulator for the sourcefed poll engine.

mod check;
mod clock;
mod input;
mod seed;
mod source;
mod store;

use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};

use jiff::Timestamp;
use sourcefed_core::{
    Clock, EngineError, EngineState, Event, EventId, MonitorConfig, MonitorId,
    PollEngine, PollInterval, Source, StoreError, TimerSource,
};

use crate::check::{Checker, ClockMark, StoreFaultKind, Trace, Violation};
use crate::clock::{ClockFault, SimClock};
use crate::input::Inputs;
use crate::seed::Seed;
use crate::source::RecordingSource;
use crate::store::{ACK_FAULT, COMMIT_FAULT, MemoryStore, StoreControl};

const JOB: &str = "deploy";
const MONITOR: &str = "sim";
const INTERVALS: [u64; 5] = [1, 2, 5, 10, 25];

/// What the run reports when it ends.
enum Outcome {
    /// The run satisfied every check it claims.
    Summary(String),
    /// At least one guarantee failed.
    Failed {
        seed: String,
        violations: Vec<Violation>,
    },
}

struct Args {
    seed: Seed,
    steps: u32,
}

fn main() -> ExitCode {
    match run() {
        Ok(Outcome::Summary(text)) => {
            println!("{text}");

            ExitCode::SUCCESS
        }
        Ok(Outcome::Failed { seed, violations }) => {
            let commit = commit();

            for violation in &violations {
                eprintln!(
                    "sourcefed-sim: seed={seed} commit={commit} violation={violation}"
                );
            }

            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("sourcefed-sim: {error}");

            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Outcome, Box<dyn Error>> {
    let args = parse_args(env::args().skip(1))?;
    let mut seed = args.seed.clone();
    let index = seed.pick_index(INTERVALS.len()).unwrap_or(0);
    let every = INTERVALS.get(index).copied().unwrap_or(1);
    let start = Timestamp::UNIX_EPOCH;
    let clock = Arc::new(SimClock::new(start));
    let store = MemoryStore::new();
    let control = store.control();
    let timer = TimerSource::new(JOB.to_owned(), every)?;
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let source = RecordingSource::new(timer, recorded.clone());
    let counter = source.poll_counter();
    let config = MonitorConfig {
        id: MonitorId::new(MONITOR.to_owned())?,
        source: source.name().clone(),
        poll_interval: PollInterval::from_secs(every)?,
    };
    let shared: Arc<dyn Clock> = clock.clone();
    let mut engine =
        PollEngine::new(config.clone(), Arc::new(source), store, shared)?;
    let mut trace = Trace::new(start, args.steps, every);
    let mut inputs = Inputs::new();
    let mut printed = HashSet::new();
    let script = Script::new(&mut seed, args.steps);

    for step in 0..args.steps {
        let marked = script.clock(step, &clock, &mut trace);
        script.advance(step, &clock, &mut trace);
        let armed_commit = script.commit(step, &control, &mut trace);

        let state = poll_once(&mut engine, &recorded, &mut trace, armed_commit)?;

        trace.polls = counter.poll_count();

        if marked {
            finish_mark(&mut trace, state);
        }

        let fresh = collect(&engine, &mut printed, &mut trace)?;
        let left = args.steps.saturating_sub(step.saturating_add(1));

        inputs.schedule(&mut seed, &fresh, left);

        let ack_fault = ack_fault_due(script.ack(step), inputs.front_is_ack());

        apply_inputs(&mut inputs, &mut engine, &control, &mut trace, ack_fault)?;

        if run_is_over(state) {
            break;
        }
    }

    let before = pending_ids(&engine);
    let store = engine.into_store();
    // The restart shares the clock but must not spend the run's step budget.
    let sleeps = clock.sleep_log();
    let (store, mut violations) =
        restart(&config, &clock, store, &before, &mut trace)?;

    trace.polls = counter.poll_count();
    trace.sleeps = sleeps;
    violations.extend(Checker::check(&trace, &clock, &store));

    if violations.is_empty() {
        Ok(Outcome::Summary(summary(
            &args.seed, every, &trace, &clock, &control,
        )))
    } else {
        Ok(Outcome::Failed {
            seed: args.seed.to_string(),
            violations,
        })
    }
}

// A scripted ack fault applies only to an ack waiting at the front.
const fn ack_fault_due(scripted: bool, queued: bool) -> bool {
    scripted && queued
}

// A halted engine leaves the poll loop.
fn run_is_over(state: EngineState) -> bool {
    state != EngineState::Running
}

// Only the armed scripted write fault leaves the engine on its schedule.
fn poll_once(
    engine: &mut PollEngine<MemoryStore>,
    recorded: &Arc<Mutex<Vec<Event>>>,
    trace: &mut Trace,
    armed_commit: bool,
) -> Result<EngineState, Box<dyn Error>> {
    match engine.run(1) {
        Ok(state) => {
            record_emissions(recorded, trace);

            Ok(state)
        }
        Err(EngineError::Store(StoreError::Write { source, .. }))
            if armed_commit && source.to_string() == COMMIT_FAULT =>
        {
            // A refused commit saves no event, so none was emitted.
            recorded
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();

            Ok(engine.state())
        }
        Err(error) => Err(Box::new(error)),
    }
}

fn pending_ids(engine: &PollEngine<MemoryStore>) -> Vec<EventId> {
    engine
        .pending()
        .unwrap_or_default()
        .iter()
        .map(Event::id)
        .cloned()
        .collect()
}

// The store and clock survive a restart; the engine and source do not.
fn restart(
    config: &MonitorConfig,
    clock: &Arc<SimClock>,
    store: MemoryStore,
    before: &[EventId],
    trace: &mut Trace,
) -> Result<(MemoryStore, Vec<Violation>), Box<dyn Error>> {
    let source = TimerSource::new(JOB.to_owned(), config.poll_interval.as_secs())?;
    let shared: Arc<dyn Clock> = clock.clone();
    let mut engine =
        PollEngine::new(config.clone(), Arc::new(source), store, shared)?;

    engine.run(1)?;

    let after = pending_ids(&engine);
    let acked: Vec<EventId> = trace.acked.iter().map(|(id, _)| id.clone()).collect();
    let violations = Checker::check_restart(before, &after, &acked, trace);

    Ok((engine.into_store(), violations))
}

// Every event a successful run returned from the source was committed.
fn record_emissions(recorded: &Arc<Mutex<Vec<Event>>>, trace: &mut Trace) {
    for event in recorded
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .drain(..)
    {
        trace.emit(event.id());
    }
}
/// Applies one input, records its ack tick, and watches for a replay.
///
/// # Errors
/// Returns a store error unless it came from the scripted ack fault.
fn apply_inputs(
    inputs: &mut Inputs,
    engine: &mut PollEngine<MemoryStore>,
    control: &StoreControl,
    trace: &mut Trace,
    ack_fault: bool,
) -> Result<(), Box<dyn Error>> {
    let acked_before = inputs.acked().len();

    if ack_fault {
        control.fail_next_ack();
        trace.store_faults.push(StoreFaultKind::Ack);
    }

    // A scripted ack fault leaves the event pending for the next poll.
    match inputs.next_input(engine) {
        Ok(true) => engine.handle().stop(),
        Ok(false) => {}
        Err(error) => {
            let write = error.downcast_ref::<StoreError>().is_some_and(|cause| {
                matches!(cause, StoreError::Write { source, .. }
                    if source.to_string() == ACK_FAULT)
            });

            if !ack_fault || !write {
                return Err(error);
            }
        }
    }

    for id in inputs.acked().get(acked_before..).unwrap_or(&[]) {
        trace.ack(id);
    }

    if let Some(pending) = engine.pending() {
        for id in inputs.acked() {
            if pending.iter().any(|event| event.id() == id) {
                trace.replay(id);
            }
        }
    }

    Ok(())
}

/// Reads the two supported flags without a command-line dependency.
///
/// # Errors
/// Returns a short reason for a missing, unknown or malformed flag.
fn parse_args<I>(words: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut seed = None;
    let mut steps = None;
    let mut argv = words.into_iter();

    while let Some(flag) = argv.next() {
        match flag.as_str() {
            "--seed" => {
                let text = argv.next().ok_or("--seed needs 16 hex digits")?;

                seed = Some(Seed::from_hex(&text)?);
            }
            "--steps" => {
                let text = argv.next().ok_or("--steps needs a u32")?;
                let value =
                    text.parse::<u32>().map_err(|_| "--steps needs a u32")?;

                if value == 0 {
                    return Err("--steps must be at least 1".into());
                }

                steps = Some(value);
            }
            other => {
                return Err(format!(
                    "unknown argument {other:?}; use --seed <hex> --steps <u32>"
                ));
            }
        }
    }

    Ok(Args {
        seed: seed.ok_or("missing --seed")?,
        steps: steps.ok_or("missing --steps")?,
    })
}

/// Scripted fault steps, all chosen from the seed.
#[derive(Clone, Copy, Debug)]
struct Script {
    future: u32,
    past: u32,
    ok: u32,
    advance: u32,
    commit: u32,
    ack: u32,
    advance_secs: u64,
}

impl Script {
    fn new(seed: &mut Seed, steps: u32) -> Self {
        let bound = u64::from(steps);
        let pick = |seed: &mut Seed| u32::try_from(seed.below(bound)).unwrap_or(0);

        Self {
            future: pick(seed),
            past: steps.saturating_sub(1),
            ok: pick(seed),
            advance: pick(seed),
            commit: pick(seed),
            ack: pick(seed),
            advance_secs: seed.below(6).saturating_add(1),
        }
    }

    // Returns whether this step added a mark for the checker.
    fn clock(&self, step: u32, clock: &SimClock, trace: &mut Trace) -> bool {
        let fault = if step == self.future {
            Some(ClockFault::Future)
        } else if step == self.past {
            Some(ClockFault::Past)
        } else if step == self.ok {
            Some(ClockFault::Ok)
        } else {
            None
        };

        if let Some(fault) = fault {
            clock.script(fault);
            trace.clock_faults.push(ClockMark {
                fault,
                polls_before: trace.polls,
                polls_after: 0,
                stopped: false,
            });

            return true;
        }

        false
    }

    fn advance(&self, step: u32, clock: &SimClock, trace: &mut Trace) {
        if step == self.advance {
            clock.advance(self.advance_secs);
            trace.advance_secs =
                trace.advance_secs.saturating_add(self.advance_secs);
        }
    }

    fn commit(&self, step: u32, control: &StoreControl, trace: &mut Trace) -> bool {
        if step == self.commit {
            control.fail_next_commit();
            trace.store_faults.push(StoreFaultKind::Commit);

            return true;
        }

        false
    }

    const fn ack(&self, step: u32) -> bool {
        step == self.ack
    }
}

fn finish_mark(trace: &mut Trace, state: EngineState) {
    if let Some(mark) = trace.clock_faults.last_mut() {
        mark.polls_after = trace.polls;
        mark.stopped = state == EngineState::Stopped;
    }
}

// Prints events that have not been printed in this run as one JSON line each.
fn collect(
    engine: &PollEngine<MemoryStore>,
    printed: &mut HashSet<EventId>,
    trace: &mut Trace,
) -> Result<Vec<Event>, Box<dyn Error>> {
    let Some(pending) = engine.pending() else {
        return Ok(Vec::new());
    };

    let mut fresh = Vec::new();
    let mut out = io::stdout().lock();

    for event in &pending {
        if printed.insert(event.id().clone()) {
            trace.print(event.id());
            fresh.push(event.clone());
            writeln!(out, "{}", serde_json::to_string(event)?)?;
        }
    }

    out.flush()?;

    Ok(fresh)
}

fn summary(
    seed: &Seed,
    every: u64,
    trace: &Trace,
    clock: &SimClock,
    control: &StoreControl,
) -> String {
    let sleeps: u64 = trace
        .sleeps
        .iter()
        .fold(0_u64, |sum, sleep| sum.saturating_add(sleep.as_secs()));
    let faults = clock.fault_count().saturating_add(control.fault_count());
    let events = trace.emitted.len();
    let polls = control.commits();

    format!(
        concat!(
            "sourcefed-sim: seed={seed} commit={commit} every={every} ",
            "polls={polls} events={events} faults={faults} sleeps={sleeps}s"
        ),
        seed = seed,
        commit = commit(),
        every = every,
        polls = polls,
        events = events,
        faults = faults,
        sleeps = sleeps,
    )
}

fn commit() -> String {
    env::var("SOURCEFED_SIM_COMMIT")
        .ok()
        .or_else(|| env::var("GITHUB_SHA").ok())
        .unwrap_or_else(|| "local".to_owned())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sourcefed_core::{
        ClockError, EventKind, EventSubject, Position, PositionKey, SourceName,
        StateStore,
    };

    use super::*;

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn test_engine(store: MemoryStore) -> PollEngine<MemoryStore> {
        let source = TimerSource::new(JOB.to_owned(), 1).unwrap();
        let config = MonitorConfig {
            id: MonitorId::new(MONITOR.to_owned()).unwrap(),
            source: source.name().clone(),
            poll_interval: PollInterval::from_secs(1).unwrap(),
        };
        let clock: Arc<dyn Clock> = Arc::new(SimClock::new(Timestamp::UNIX_EPOCH));

        PollEngine::new(config, Arc::new(source), store, clock).unwrap()
    }

    fn key() -> PositionKey {
        PositionKey {
            monitor: MonitorId::new(MONITOR.to_owned()).unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        }
    }

    fn sample_event(id: &str) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn store_with(events: &[Event]) -> MemoryStore {
        let mut store = MemoryStore::new();
        let saved = store
            .commit(key(), Position::new("1".into()).unwrap(), events)
            .unwrap();

        assert_eq!(saved, events.len());

        store
    }

    fn script() -> Script {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();

        Script::new(&mut seed, 6)
    }

    fn ack_inputs(event: &Event) -> Inputs {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
        let mut inputs = Inputs::new();

        inputs.schedule(&mut seed, std::slice::from_ref(event), 2);

        inputs
    }

    fn stop_inputs() -> Inputs {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
        let mut inputs = Inputs::new();

        inputs.schedule(&mut seed, &[], 1);

        inputs
    }

    #[test]
    fn pending_ids_reads_the_store_queue() {
        let empty = test_engine(MemoryStore::new());
        let expected: Vec<EventId> = Vec::new();

        assert_eq!(pending_ids(&empty), expected);

        let source = sourcefed_core::SourceName::new("timer".into()).unwrap();
        let subject =
            sourcefed_core::EventSubject::new(source.clone(), JOB.into()).unwrap();
        let event = Event::new(
            EventId::new("e1".into()).unwrap(),
            sourcefed_core::EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let key = sourcefed_core::PositionKey {
            monitor: MonitorId::new(MONITOR.to_owned()).unwrap(),
            source,
        };
        let mut store = MemoryStore::new();

        assert_eq!(
            store
                .commit(
                    key,
                    sourcefed_core::Position::new("1".into()).unwrap(),
                    std::slice::from_ref(&event),
                )
                .unwrap(),
            1
        );

        let engine = test_engine(store);

        assert_eq!(pending_ids(&engine), vec![event.id().clone()]);
    }

    fn error(words: &[&str]) -> String {
        parse_args(argv(words))
            .err()
            .unwrap_or_else(|| "no error".to_owned())
    }

    #[test]
    fn parses_a_seed_and_a_step_count() {
        let args =
            parse_args(argv(&["--seed", "0000000000000001", "--steps", "20"]))
                .unwrap();

        assert_eq!(args.seed.to_string(), "0000000000000001");
        assert_eq!(args.steps, 20);
    }

    #[test]
    fn rejects_a_missing_seed() {
        assert_eq!(error(&["--steps", "20"]), "missing --seed");
    }

    #[test]
    fn rejects_a_missing_step_count() {
        assert_eq!(error(&["--seed", "0000000000000001"]), "missing --steps");
    }

    #[test]
    fn rejects_an_unknown_flag() {
        assert_eq!(
            error(&["--bogus"]),
            "unknown argument \"--bogus\"; use --seed <hex> --steps <u32>"
        );
    }

    #[test]
    fn rejects_a_missing_seed_value() {
        assert_eq!(error(&["--seed"]), "--seed needs 16 hex digits");
    }

    #[test]
    fn rejects_a_missing_steps_value() {
        assert_eq!(error(&["--steps"]), "--steps needs a u32");
    }

    #[test]
    fn rejects_a_malformed_seed() {
        assert_eq!(
            error(&["--seed", "00000000000000f"]),
            "seed must be 16 hexadecimal digits"
        );
    }

    #[test]
    fn rejects_a_malformed_step_count() {
        assert_eq!(
            error(&["--seed", "0000000000000001", "--steps", "many"]),
            "--steps needs a u32"
        );
    }

    #[test]
    fn rejects_a_zero_step_count() {
        assert_eq!(
            error(&["--seed", "0000000000000001", "--steps", "0"]),
            "--steps must be at least 1"
        );
    }

    #[test]
    fn seed_stream_is_deterministic() {
        let mut first = Seed::from_hex("00000000000000ff").unwrap();
        let mut second = Seed::from_hex("00000000000000ff").unwrap();
        let left: Vec<u64> = (0..4).map(|_| first.next_u64()).collect();
        let right: Vec<u64> = (0..4).map(|_| second.next_u64()).collect();

        assert_eq!(
            left,
            vec![
                0x338c_5071_4628_3fb4,
                0xef84_b9a8_2c2c_8d15,
                0xd66c_8117_e962_d63d,
                0xa616_a87e_6e2a_e1ad,
            ]
        );
        assert_eq!(left, right);
        assert_eq!(first, second);
    }

    #[test]
    fn seed_from_hex_validates_width_and_digits() {
        assert_eq!(
            Seed::from_hex("00000000000000ff").unwrap().to_string(),
            "00000000000000ff"
        );
        assert_eq!(
            Seed::from_hex("00000000000000FF").unwrap().to_string(),
            "00000000000000ff"
        );
        assert_eq!(
            Seed::from_hex("00000000000000f").err(),
            Some("seed must be 16 hexadecimal digits".to_owned())
        );
        assert_eq!(
            Seed::from_hex("00000000000000gg").err(),
            Some("seed must be 16 hexadecimal digits".to_owned())
        );
    }

    #[test]
    fn script_new_draws_each_fault_from_the_seed() {
        let script = script();

        assert_eq!(script.future, 4);
        assert_eq!(script.past, 5);
        assert_eq!(script.ok, 2);
        assert_eq!(script.advance, 3);
        assert_eq!(script.commit, 0);
        assert_eq!(script.ack, 1);
        assert_eq!(script.advance_secs, 4);
    }

    #[test]
    fn clock_scripts_each_fault_at_its_step() {
        let script = script();
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        let mut trace = Trace::default();

        assert!(!script.clock(1, &clock, &mut trace));
        assert_eq!(trace.clock_faults, Vec::new());

        assert!(script.clock(4, &clock, &mut trace));
        assert_eq!(clock.now(), Err(ClockError::Future));

        assert!(script.clock(5, &clock, &mut trace));
        assert_eq!(clock.now(), Err(ClockError::Past));

        assert!(script.clock(2, &clock, &mut trace));
        assert_eq!(clock.now(), Ok(Timestamp::UNIX_EPOCH));

        let marks = vec![
            ClockMark {
                fault: ClockFault::Future,
                polls_before: 0,
                polls_after: 0,
                stopped: false,
            },
            ClockMark {
                fault: ClockFault::Past,
                polls_before: 0,
                polls_after: 0,
                stopped: false,
            },
            ClockMark {
                fault: ClockFault::Ok,
                polls_before: 0,
                polls_after: 0,
                stopped: false,
            },
        ];

        assert_eq!(trace.clock_faults, marks);
    }

    #[test]
    fn advance_moves_time_only_on_its_step() {
        let script = script();
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        let mut trace = Trace::default();

        script.advance(2, &clock, &mut trace);

        assert_eq!(trace.advance_secs, 0);
        assert_eq!(clock.virtual_now(), Timestamp::UNIX_EPOCH);

        script.advance(3, &clock, &mut trace);
        let expected = Timestamp::UNIX_EPOCH
            .checked_add(Duration::from_secs(4))
            .unwrap();

        assert_eq!(trace.advance_secs, 4);
        assert_eq!(clock.virtual_now(), expected);
    }

    #[test]
    fn commit_arms_a_fault_only_on_its_step() {
        let script = script();
        let mut store = MemoryStore::new();
        let control = store.control();
        let mut trace = Trace::default();

        assert!(!script.commit(1, &control, &mut trace));
        assert_eq!(control.fault_count(), 0);
        assert_eq!(trace.store_faults, Vec::new());

        assert!(script.commit(0, &control, &mut trace));
        assert_eq!(trace.store_faults, vec![StoreFaultKind::Commit]);

        let result = store.commit(key(), Position::new("1".into()).unwrap(), &[]);

        assert!(matches!(
            result,
            Err(StoreError::Write { source, .. })
                if source.to_string() == COMMIT_FAULT
        ));
        assert_eq!(control.fault_count(), 1);
    }

    #[test]
    fn ack_matches_only_its_step() {
        let script = script();

        assert!(!script.ack(0));
        assert!(script.ack(1));
        assert!(!script.ack(5));
    }

    #[test]
    fn an_ack_fault_needs_both_the_script_and_a_queued_ack() {
        assert!(!ack_fault_due(false, false));
        assert!(!ack_fault_due(false, true));
        assert!(!ack_fault_due(true, false));
        assert!(ack_fault_due(true, true));
    }

    #[test]
    fn only_a_halted_engine_ends_the_run() {
        assert!(!run_is_over(EngineState::Running));
        assert!(run_is_over(EngineState::Stopped));
        assert!(run_is_over(EngineState::Ended));
    }

    #[test]
    fn finish_mark_records_polls_and_stop() {
        let mut trace = Trace::default();
        trace.polls = 7;
        trace.clock_faults.push(ClockMark {
            fault: ClockFault::Ok,
            polls_before: 2,
            polls_after: 0,
            stopped: false,
        });

        finish_mark(&mut trace, EngineState::Stopped);

        assert_eq!(
            trace.clock_faults,
            vec![ClockMark {
                fault: ClockFault::Ok,
                polls_before: 2,
                polls_after: 7,
                stopped: true,
            }]
        );

        finish_mark(&mut trace, EngineState::Running);

        assert_eq!(
            trace.clock_faults,
            vec![ClockMark {
                fault: ClockFault::Ok,
                polls_before: 2,
                polls_after: 7,
                stopped: false,
            }]
        );
    }

    #[test]
    fn record_emissions_drains_the_recorder() {
        let event = sample_event("e1");
        let recorded = Arc::new(Mutex::new(vec![event.clone()]));
        let mut trace = Trace::default();

        record_emissions(&recorded, &mut trace);

        assert_eq!(trace.emitted, vec![event.id().clone()]);
        assert_eq!(*recorded.lock().unwrap(), Vec::new());
    }

    #[test]
    fn collect_prints_each_pending_event_once() {
        let event = sample_event("e1");
        let engine = test_engine(store_with(std::slice::from_ref(&event)));
        let mut printed = HashSet::new();
        let mut trace = Trace::default();

        let fresh = collect(&engine, &mut printed, &mut trace).unwrap();

        assert_eq!(fresh, vec![event.clone()]);
        assert_eq!(trace.printed, vec![(event.id().clone(), 1)]);
        assert!(printed.contains(event.id()));

        let again = collect(&engine, &mut printed, &mut trace).unwrap();

        assert_eq!(again, Vec::new());
        assert_eq!(trace.printed, vec![(event.id().clone(), 1)]);
    }

    #[test]
    fn summary_reports_exact_counts_and_commit() {
        let seed = Seed::from_hex("0000000000000001").unwrap();
        let clock = SimClock::new(Timestamp::UNIX_EPOCH);
        clock.script(ClockFault::Future);
        assert_eq!(clock.now(), Err(ClockError::Future));

        let mut store = MemoryStore::new();
        let control = store.control();
        let saved = store
            .commit(key(), Position::new("1".into()).unwrap(), &[])
            .unwrap();

        assert_eq!(saved, 0);

        control.fail_next_commit();
        let refused = store.commit(key(), Position::new("2".into()).unwrap(), &[]);

        assert!(matches!(refused, Err(StoreError::Write { .. })));

        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 3, 7);
        trace.emit(sample_event("e1").id());
        trace.emit(sample_event("e2").id());
        trace.sleeps.push(Duration::from_secs(3));
        trace.sleeps.push(Duration::from_secs(4));

        let expected = format!(
            concat!(
                "sourcefed-sim: seed=0000000000000001 commit={} ",
                "every=7 polls=1 events=2 faults=2 sleeps=7s"
            ),
            commit()
        );

        assert_eq!(summary(&seed, 7, &trace, &clock, &control), expected);
    }

    #[test]
    fn poll_once_accepts_its_own_scripted_commit_fault() {
        let store = MemoryStore::new();
        let control = store.control();
        control.fail_next_commit();
        let mut engine = test_engine(store);
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let mut trace = Trace::default();

        let state = poll_once(&mut engine, &recorded, &mut trace, true).unwrap();

        assert_eq!(state, EngineState::Running);
        assert_eq!(control.fault_count(), 1);
        assert_eq!(trace.emitted, Vec::new());
        assert_eq!(*recorded.lock().unwrap(), Vec::new());
    }

    #[test]
    fn poll_once_reports_a_commit_fault_it_did_not_arm() {
        let store = MemoryStore::new();
        let control = store.control();
        control.fail_next_commit();
        let mut engine = test_engine(store);
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let mut trace = Trace::default();

        let error =
            poll_once(&mut engine, &recorded, &mut trace, false).unwrap_err();
        let write = error.downcast_ref::<EngineError>().is_some_and(|cause| {
            matches!(
                cause,
                EngineError::Store(StoreError::Write { source, .. })
                    if source.to_string() == COMMIT_FAULT
            )
        });

        assert!(write);
        assert_eq!(control.fault_count(), 1);
        assert_eq!(trace.emitted, Vec::new());
    }

    #[test]
    fn apply_inputs_swallows_its_own_ack_fault() {
        let event = sample_event("e1");
        let store = store_with(std::slice::from_ref(&event));
        let control = store.control();
        let mut engine = test_engine(store);
        let mut inputs = ack_inputs(&event);
        let mut trace = Trace::default();

        assert!(inputs.front_is_ack());

        apply_inputs(&mut inputs, &mut engine, &control, &mut trace, true).unwrap();

        let pending: Vec<EventId> = engine
            .pending()
            .unwrap()
            .iter()
            .map(Event::id)
            .cloned()
            .collect();

        assert_eq!(trace.store_faults, vec![StoreFaultKind::Ack]);
        assert_eq!(trace.acked, Vec::new());
        assert_eq!(control.fault_count(), 1);
        assert_eq!(pending, vec![event.id().clone()]);
    }

    #[test]
    fn apply_inputs_reports_an_ack_fault_it_did_not_arm() {
        let event = sample_event("e1");
        let store = store_with(std::slice::from_ref(&event));
        let control = store.control();
        let mut engine = test_engine(store);
        let mut inputs = ack_inputs(&event);
        let mut trace = Trace::default();
        control.fail_next_ack();

        let error =
            apply_inputs(&mut inputs, &mut engine, &control, &mut trace, false)
                .unwrap_err();
        let write = error.downcast_ref::<StoreError>().is_some_and(|cause| {
            matches!(
                cause,
                StoreError::Write { source, .. }
                    if source.to_string() == ACK_FAULT
            )
        });

        assert!(write);
        assert_eq!(trace.store_faults, Vec::new());
        assert_eq!(trace.acked, Vec::new());
    }

    #[test]
    fn apply_inputs_stops_on_a_queued_stop() {
        let store = store_with(&[]);
        let control = store.control();
        let mut engine = test_engine(store);
        let mut inputs = stop_inputs();
        let mut trace = Trace::default();

        apply_inputs(&mut inputs, &mut engine, &control, &mut trace, false).unwrap();

        assert!(engine.handle().is_stopped());
        assert_eq!(trace.store_faults, Vec::new());
        assert_eq!(trace.acked, Vec::new());
    }

    #[test]
    fn apply_inputs_records_a_saved_ack() {
        let event = sample_event("e1");
        let store = store_with(std::slice::from_ref(&event));
        let control = store.control();
        let mut engine = test_engine(store);
        let mut inputs = ack_inputs(&event);
        let mut trace = Trace::default();

        apply_inputs(&mut inputs, &mut engine, &control, &mut trace, false).unwrap();

        assert_eq!(trace.acked, vec![(event.id().clone(), 1)]);
        assert_eq!(inputs.acked(), std::slice::from_ref(event.id()));
        assert_eq!(engine.pending().unwrap().len(), 0);
    }
}
