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

        let ack_fault = script.ack(step) && inputs.front_is_ack();

        apply_inputs(&mut inputs, &mut engine, &control, &mut trace, ack_fault)?;

        if state != EngineState::Running {
            break;
        }
    }

    let before = pending_ids(&engine);
    let store = engine.into_store();
    let (store, mut violations) =
        restart(&config, &clock, store, &before, &mut trace)?;

    trace.polls = counter.poll_count();
    trace.sleeps = clock.sleep_log();
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
    use sourcefed_core::StateStore;

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
}
