//! A seeded simulator for the sourcefed poll engine.

mod check;
mod clock;
mod input;
mod seed;
mod store;

use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::Arc;

use jiff::Timestamp;
use sourcefed_core::{
    Clock, EngineState, Event, EventId, MonitorConfig, MonitorId, PollEngine,
    PollInterval, Source, TimerSource,
};

use crate::check::{Checker, ClockMark, StoreFaultKind, Trace, Violation};
use crate::clock::{ClockFault, SimClock};
use crate::input::Inputs;
use crate::seed::Seed;
use crate::store::{MemoryStore, StoreControl};

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
    let args = parse_args()?;
    let mut seed = args.seed.clone();
    let index = seed.pick_index(INTERVALS.len()).unwrap_or(0);
    let every = INTERVALS.get(index).copied().unwrap_or(1);
    let start = Timestamp::UNIX_EPOCH;
    let clock = Arc::new(SimClock::new(start));
    let store = MemoryStore::new();
    let control = store.control();
    let source = TimerSource::new(JOB.to_owned(), every)?;
    let config = MonitorConfig {
        id: MonitorId::new(MONITOR.to_owned())?,
        source: source.name().clone(),
        poll_interval: PollInterval::from_secs(every)?,
    };
    let shared: Arc<dyn Clock> = clock.clone();
    let mut engine = PollEngine::new(config, Arc::new(source), store, shared)?;
    let mut trace = Trace::new(start, args.steps, every);
    let mut inputs = Inputs::new();
    let mut printed = HashSet::new();
    let script = Script::new(&mut seed, args.steps);

    for step in 0..args.steps {
        let marked = script.clock(step, &clock, &mut trace);
        script.advance(step, &clock, &mut trace);
        script.commit(step, &control, &mut trace);

        // A scripted store fault leaves the schedule and state unchanged.
        let state = engine.run(1).unwrap_or_else(|_| engine.state());

        trace.polls = control.commits();

        if marked {
            finish_mark(&mut trace, state);
        }

        let fresh = collect(&engine, &mut printed, &mut trace)?;
        let left = args.steps.saturating_sub(step.saturating_add(1));

        inputs.schedule(&mut seed, &fresh, left);

        if script.ack(step) && inputs.has_queued() {
            control.fail_next_ack();
            trace.store_faults.push(StoreFaultKind::Ack);
        }

        // A scripted ack fault leaves the event pending for the next poll.
        if matches!(inputs.next_input(&mut engine), Ok(true)) {
            engine.handle().stop();
        }

        if state != EngineState::Running {
            break;
        }
    }

    let store = engine.into_store();

    for id in inputs.acked() {
        trace.ack(id);
    }

    trace.polls = control.commits();
    trace.sleeps = clock.sleep_log();

    let violations = Checker::check(&trace, &clock, &store);

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

/// Reads the two supported flags without a command-line dependency.
///
/// # Errors
/// Returns a short reason for a missing, unknown or malformed flag.
fn parse_args() -> Result<Args, String> {
    let mut seed = None;
    let mut steps = None;
    let mut argv = env::args().skip(1);

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

    fn commit(&self, step: u32, control: &StoreControl, trace: &mut Trace) {
        if step == self.commit {
            control.fail_next_commit();
            trace.store_faults.push(StoreFaultKind::Commit);
        }
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
            trace.emit(event.id());
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
    let polls = trace.polls;

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
