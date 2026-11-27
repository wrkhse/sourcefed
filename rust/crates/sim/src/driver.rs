//! Bounded simulation of the real poll engine with scripted inputs.

use std::collections::{HashSet, VecDeque};
use std::error::Error;
use std::io::Write;
use std::sync::Arc;

use jiff::Timestamp;
use sourcefed_core::{
    EngineState, Event, EventId, MonitorConfig, MonitorId, PollEngine, PollInterval,
    Source, TimerSource,
};
use sourcefed_sim::{MemoryStore, Seed, SimClock};

use crate::check::Trace;
use crate::input::ScriptedInputs;

const NO_PENDING: &str = "sim: missing pending queue";

/// Why a simulation run ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    /// A scripted stop input ended the run.
    Stopped,
    /// The engine stopped or finished on its own.
    Ended,
    /// The step budget ran out.
    Budget,
}

/// What one simulation run did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Summary {
    pub steps: u32,
    pub events: usize,
    pub outcome: Outcome,
}

/// A run's summary together with the observations it produced.
#[derive(Debug)]
pub struct Run {
    pub summary: Summary,
    pub trace: Trace,
}

/// Builds a real engine over a timer, the virtual clock and memory store.
///
/// # Errors
/// Returns the validation error when the monitor, interval or engine cannot
/// be built.
#[cfg(test)]
pub fn engine() -> Result<PollEngine<MemoryStore>, String> {
    build_engine()
}

fn build_engine() -> Result<PollEngine<MemoryStore>, String> {
    let source = TimerSource::new("sim".into(), 1).map_err(|e| e.to_string())?;
    let config = MonitorConfig {
        id: MonitorId::new("sim".into()).map_err(|e| e.to_string())?,
        source: source.name().clone(),
        poll_interval: PollInterval::from_secs(1).map_err(|e| e.to_string())?,
    };
    let clock = Arc::new(SimClock::new(Timestamp::UNIX_EPOCH));

    PollEngine::new(config, Arc::new(source), MemoryStore::new(), clock)
        .map_err(|e| e.to_string())
}

/// Runs at most `steps` bounded polls, writing new pending events as lines.
///
/// # Errors
/// Returns the engine, store, serialisation or output error that ends the run.
#[cfg(test)]
pub fn simulate(
    seed: Seed,
    steps: u32,
    out: &mut impl Write,
) -> Result<Summary, Box<dyn Error>> {
    Ok(simulate_with_trace(seed, steps, out)?.summary)
}

/// Runs the simulation and records what delivery can inspect.
///
/// # Errors
/// Returns the engine, store, serialisation or output error that ends the run.
pub fn simulate_with_trace(
    seed: Seed,
    steps: u32,
    out: &mut impl Write,
) -> Result<Run, Box<dyn Error>> {
    let mut engine = build_engine()?;
    let mut inputs = ScriptedInputs::new();
    let mut printed = HashSet::new();
    let mut trace = Trace::default();
    let mut draw = seed;
    let mut events = 0_usize;
    let mut taken = 0_u32;
    let mut outcome = Outcome::Budget;

    for index in 0..steps {
        taken = index.saturating_add(1);
        let left = steps.saturating_sub(index);
        let state = engine.run(1)?;

        if state != EngineState::Running {
            outcome = Outcome::Ended;
            break;
        }

        // The first timer poll only sets its position, so no queue exists
        // yet. A queue missing after that is an error, not an empty run.
        let queued = engine.pending();
        let had_pending = queued.is_some();
        let pending: Vec<_> = pending_or_error(queued, index)?.into();
        record_emitted(&mut trace, &pending);

        if had_pending {
            let fresh = fresh_ids(&pending, &printed);
            let count = print_new(&engine, &mut printed, out)?;
            events = events.saturating_add(count);
            trace.printed.extend(fresh);
        }

        inputs.schedule(&mut draw, &pending, left);

        let stopped = if left == 1 {
            inputs.apply_all(&mut engine)?
        } else {
            inputs.apply_next(&mut engine)?
        };

        record_step_inputs(&mut trace, &engine, inputs.acked_ids())?;
        forget_acked(&engine, &mut printed);

        if stopped {
            outcome = Outcome::Stopped;
            break;
        }
    }

    Ok(Run {
        summary: Summary {
            steps: taken,
            events,
            outcome,
        },
        trace,
    })
}

// IDs in this pending snapshot that have not been printed yet.
fn fresh_ids(pending: &[Event], printed: &HashSet<EventId>) -> Vec<String> {
    pending
        .iter()
        .filter(|event| !printed.contains(event.id()))
        .map(|event| String::from(event.id().as_str()))
        .collect()
}

// Records each pending ID the first time the engine exposes it.
fn record_emitted(trace: &mut Trace, pending: &[Event]) {
    for event in pending {
        let id = String::from(event.id().as_str());

        if !trace.emitted.contains(&id) {
            trace.emitted.push(id);
        }
    }
}

// Records only the IDs of Ack inputs that were applied this run.
fn record_acked(trace: &mut Trace, acked: &[EventId]) {
    for id in acked {
        let id = String::from(id.as_str());

        if !trace.acked.contains(&id) {
            trace.acked.push(id);
        }
    }
}

// Records applied acks and any acked ID replayed after this step's inputs.
// Replay detection runs whenever acks exist or a queue can be read; skipping
// it is only safe for a priming step with neither.
//
// # Errors
// Returns NO_PENDING when acks exist but the queue cannot be read.
fn record_step_inputs(
    trace: &mut Trace,
    engine: &PollEngine<MemoryStore>,
    acked: &[EventId],
) -> Result<(), &'static str> {
    record_acked(trace, acked);

    if !trace.acked.is_empty() || engine.pending().is_some() {
        record_replayed(trace, engine)?;
    }

    Ok(())
}

// Records each acked ID that is present in pending after this step's inputs.
// An absent queue has no ID to replay, yet the failed read is an error rather
// than a silent pass, so the checker never runs without full observation.
//
// # Errors
// Returns NO_PENDING when the queue cannot be read.
fn record_replayed(
    trace: &mut Trace,
    engine: &PollEngine<MemoryStore>,
) -> Result<(), &'static str> {
    let Some(pending) = engine.pending() else {
        return Err(NO_PENDING);
    };

    for id in &trace.acked {
        let returning = pending
            .iter()
            .any(|event| event.id().as_str() == id.as_str());

        if returning && !trace.replayed.contains(id) {
            trace.replayed.push(id.clone());
        }
    }

    Ok(())
}

fn pending_or_error(
    pending: Option<VecDeque<Event>>,
    index: u32,
) -> Result<VecDeque<Event>, &'static str> {
    match pending {
        Some(pending) => Ok(pending),
        None if index == 0 => Ok(VecDeque::new()),
        None => Err(NO_PENDING),
    }
}

fn print_new(
    engine: &PollEngine<MemoryStore>,
    seen: &mut HashSet<EventId>,
    out: &mut impl Write,
) -> Result<usize, Box<dyn Error>> {
    let Some(pending) = engine.pending() else {
        return Err(NO_PENDING.into());
    };

    let mut count = 0_usize;

    for event in &pending {
        if seen.insert(event.id().clone()) {
            writeln!(out, "{}", serde_json::to_string(event)?)?;
            count = count.saturating_add(1);
        }
    }

    out.flush()?;

    Ok(count)
}

// Forgets delivered IDs only after this step's acks have removed their
// events, so an acked ID can be printed again if its event returns.
fn forget_acked(engine: &PollEngine<MemoryStore>, seen: &mut HashSet<EventId>) {
    let Some(pending) = engine.pending() else {
        seen.clear();
        return;
    };

    seen.retain(|id| pending.iter().any(|event| event.id() == id));
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use sourcefed_core::{
        Event, EventKind, EventSubject, Position, PositionKey, SourceName,
        StateStore,
    };

    use super::*;

    fn named_event(id: &str) -> Event {
        let source = SourceName::new("sim".into()).unwrap();
        let subject = EventSubject::new(source, "sim".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn engine_with_pending(events: &[Event]) -> PollEngine<MemoryStore> {
        let source = TimerSource::new("sim".into(), 1).unwrap();
        let config = MonitorConfig {
            id: MonitorId::new("sim".into()).unwrap(),
            source: source.name().clone(),
            poll_interval: PollInterval::from_secs(1).unwrap(),
        };
        let key = PositionKey {
            monitor: config.id.clone(),
            source: config.source.clone(),
        };
        let mut store = MemoryStore::new();
        store
            .commit(key, Position::new("cursor".into()).unwrap(), events)
            .unwrap();

        PollEngine::new(
            config,
            Arc::new(source),
            store,
            Arc::new(SimClock::new(Timestamp::UNIX_EPOCH)),
        )
        .unwrap()
    }

    #[test]
    fn the_same_seed_and_steps_print_the_same_events() {
        let mut first = Vec::new();
        let mut again = Vec::new();
        let a = simulate(Seed::from_u64(1), 8, &mut first).unwrap();
        let b = simulate(Seed::from_u64(1), 8, &mut again).unwrap();

        assert_eq!(first, again);
        assert_eq!(a, b);
        assert_eq!(a.steps, 8);
        assert_eq!(a.outcome, Outcome::Stopped);
        assert_ne!(first, Vec::<u8>::new());
    }

    #[test]
    fn different_seeds_can_end_a_run_differently() {
        let mut even_out = Vec::new();
        let mut odd_out = Vec::new();
        let even = simulate(Seed::from_u64(125), 1, &mut even_out).unwrap();
        let odd = simulate(Seed::from_u64(119), 1, &mut odd_out).unwrap();

        assert_eq!(even.outcome, Outcome::Stopped);
        assert_eq!(odd.outcome, Outcome::Budget);
        assert_ne!(even.outcome, odd.outcome);
    }

    #[test]
    fn every_polled_event_is_printed_before_inputs_are_applied() {
        let mut first = Vec::new();
        let mut other = Vec::new();

        simulate(Seed::from_u64(1), 8, &mut first).unwrap();
        simulate(Seed::from_u64(2), 8, &mut other).unwrap();

        assert_eq!(first, other);
        assert_eq!(String::from_utf8(first).unwrap().lines().count(), 7);
    }

    #[test]
    fn an_odd_final_stop_draw_leaves_the_budget_as_the_outcome() {
        let mut out = Vec::new();
        let seed = Seed::from_u64(1);
        let steps = 2;

        let summary = simulate(seed, steps, &mut out).unwrap();

        assert_eq!(
            summary,
            Summary {
                steps,
                events: 1,
                outcome: Outcome::Budget,
            }
        );
    }

    #[test]
    fn a_single_step_applies_the_final_stop_without_a_pending_queue() {
        let mut out = Vec::new();
        let seed = Seed::from_u64(0x3C6E_F372_FE94_F82B);

        let summary = simulate(seed, 1, &mut out).unwrap();

        assert_eq!(
            summary,
            Summary {
                steps: 1,
                events: 0,
                outcome: Outcome::Stopped,
            }
        );
        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn final_step_events_are_printed_before_the_stop() {
        let mut out = Vec::new();
        let seed = Seed::from_u64(0x3C6E_F372_FE94_F82B);

        let summary = simulate(seed, 2, &mut out).unwrap();

        assert_eq!(
            summary,
            Summary {
                steps: 2,
                events: 1,
                outcome: Outcome::Stopped,
            }
        );
        let printed = String::from_utf8(out).unwrap();
        let lines: Vec<_> = printed.lines().collect();

        assert_eq!(lines.len(), 1);
        let event: serde_json::Value = serde_json::from_str(lines[0]).unwrap();

        assert_eq!(event["id"], "timer:sim:1970-01-01T00:00:01Z");
    }

    #[test]
    fn pending_or_error_allows_no_queue_on_the_first_step() {
        assert_eq!(pending_or_error(None, 0), Ok(VecDeque::new()));
    }

    #[test]
    fn pending_or_error_rejects_no_queue_on_a_later_step() {
        assert_eq!(pending_or_error(None, 1), Err(NO_PENDING));
    }

    #[test]
    fn pending_or_error_returns_the_provided_queue_unchanged() {
        let source = SourceName::new("sim".into()).unwrap();
        let subject = EventSubject::new(source, "sim".into()).unwrap();
        let event = Event::new(
            EventId::new("timer:sim:1970-01-01T00:00:03Z".into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let queue = VecDeque::from([event]);

        assert_eq!(pending_or_error(Some(queue.clone()), 3), Ok(queue));
    }

    #[test]
    fn a_missing_pending_queue_is_reported_as_an_error() {
        let engine = engine().unwrap();
        let mut seen = HashSet::new();
        let mut out = Vec::new();

        let result = print_new(&engine, &mut seen, &mut out);

        assert_eq!(
            result.err().map(|error| error.to_string()),
            Some(String::from("sim: missing pending queue"))
        );
        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn a_forgotten_id_is_printed_again_when_it_returns() {
        let source = SourceName::new("sim".into()).unwrap();
        let subject = EventSubject::new(source, "sim".into()).unwrap();
        let first = Event::new(
            EventId::new("first".into()).unwrap(),
            EventKind::TimerFired,
            subject.clone(),
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let second = Event::new(
            EventId::new("second".into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let first_line = format!("{}\n", serde_json::to_string(&first).unwrap());
        let second_line = format!("{}\n", serde_json::to_string(&second).unwrap());
        let mut seen = HashSet::new();
        let mut out = Vec::new();

        let one = engine_with_pending(std::slice::from_ref(&first));

        assert_eq!(print_new(&one, &mut seen, &mut out).unwrap(), 1);
        assert_eq!(out.as_slice(), first_line.as_bytes());

        let both = engine_with_pending(&[first.clone(), second.clone()]);

        assert_eq!(print_new(&both, &mut seen, &mut out).unwrap(), 1);
        assert_eq!(
            out.as_slice(),
            format!("{first_line}{second_line}").as_bytes()
        );

        let second_only = engine_with_pending(std::slice::from_ref(&second));

        assert_eq!(print_new(&second_only, &mut seen, &mut out).unwrap(), 0);
        assert_eq!(
            out.as_slice(),
            format!("{first_line}{second_line}").as_bytes()
        );

        forget_acked(&second_only, &mut seen);

        let first_again = engine_with_pending(std::slice::from_ref(&first));

        assert_eq!(print_new(&first_again, &mut seen, &mut out).unwrap(), 1);
        assert_eq!(
            out.as_slice(),
            format!("{first_line}{second_line}{first_line}").as_bytes()
        );
    }

    #[test]
    fn forget_acked_drops_an_id_as_soon_as_it_is_acked() {
        let source = SourceName::new("sim".into()).unwrap();
        let subject = EventSubject::new(source, "sim".into()).unwrap();
        let first = Event::new(
            EventId::new("first".into()).unwrap(),
            EventKind::TimerFired,
            subject.clone(),
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let second = Event::new(
            EventId::new("second".into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        let mut engine = engine_with_pending(&[first.clone(), second.clone()]);
        let mut seen = HashSet::new();
        let mut out = Vec::new();

        assert_eq!(print_new(&engine, &mut seen, &mut out).unwrap(), 2);
        assert_eq!(
            seen,
            HashSet::from([first.id().clone(), second.id().clone()])
        );

        assert_eq!(engine.ack(std::slice::from_ref(first.id())).unwrap(), 1);
        assert_eq!(engine.pending(), Some(VecDeque::from([second.clone()])));

        forget_acked(&engine, &mut seen);

        assert_eq!(seen, HashSet::from([second.id().clone()]));
    }

    #[test]
    fn record_emitted_adds_each_new_id_once() {
        let existing = named_event("existing");
        let fresh = named_event("fresh");
        let mut trace = Trace {
            emitted: vec![String::from("existing")],
            ..Default::default()
        };

        record_emitted(&mut trace, &[existing, fresh]);

        assert_eq!(
            trace.emitted,
            vec![String::from("existing"), String::from("fresh")]
        );
        assert_eq!(trace.printed, Vec::<String>::new());
        assert_eq!(trace.acked, Vec::<String>::new());
    }

    #[test]
    fn an_emitted_but_unprinted_id_reaches_the_checker_as_a_violation() {
        use crate::check::Checker;

        let event = named_event("emitted-only");
        let mut trace = Trace::default();

        record_emitted(&mut trace, std::slice::from_ref(&event));

        assert_eq!(trace.emitted, vec![String::from("emitted-only")]);
        assert_eq!(trace.printed, Vec::<String>::new());
        assert_eq!(
            Checker::check(&trace),
            vec![crate::check::Violation {
                guarantee: crate::check::Guarantee::AtLeastOnceDelivery,
                reason: String::from(
                    "emitted event emitted-only was neither printed nor acked"
                ),
            }]
        );
    }

    #[test]
    fn record_acked_adds_only_applied_ids_once() {
        let acked = [
            EventId::new("first".into()).unwrap(),
            EventId::new("already-recorded".into()).unwrap(),
        ];
        let mut trace = Trace {
            acked: vec![String::from("already-recorded")],
            ..Default::default()
        };

        record_acked(&mut trace, &acked);

        assert_eq!(
            trace.acked,
            vec![String::from("already-recorded"), String::from("first")]
        );
    }

    #[test]
    fn record_replayed_adds_a_returning_acked_id_once_and_ignores_fresh_ids() {
        let returning = named_event("returning");
        let fresh = named_event("fresh");
        let mut trace = Trace {
            acked: vec![String::from("returning")],
            ..Default::default()
        };
        let engine = engine_with_pending(&[returning, fresh]);

        record_replayed(&mut trace, &engine).unwrap();

        assert_eq!(trace.replayed, vec![String::from("returning")]);

        let engine_again =
            engine_with_pending(&[named_event("returning"), named_event("fresh")]);
        record_replayed(&mut trace, &engine_again).unwrap();

        assert_eq!(trace.replayed, vec![String::from("returning")]);
    }

    #[test]
    fn a_priming_step_with_no_acks_or_queue_skips_replay_detection() {
        let engine = engine().unwrap();
        let acked: [EventId; 0] = [];
        let mut trace = Trace::default();

        let result = record_step_inputs(&mut trace, &engine, &acked);

        assert_eq!(result, Ok(()));
        assert_eq!(trace.acked, Vec::<String>::new());
        assert_eq!(trace.replayed, Vec::<String>::new());
    }

    #[test]
    fn a_priming_step_with_an_ack_and_no_queue_fails_closed() {
        let engine = engine().unwrap();
        let acked = [EventId::new("returning".into()).unwrap()];
        let mut trace = Trace::default();

        let result = record_step_inputs(&mut trace, &engine, &acked);

        assert_eq!(result, Err(NO_PENDING));
        assert_eq!(trace.acked, vec![String::from("returning")]);
        assert_eq!(trace.replayed, Vec::<String>::new());
    }

    #[test]
    fn replay_detection_fails_on_a_missing_pending_queue() {
        let engine = engine().unwrap();
        let acked = [EventId::new("returning".into()).unwrap()];
        let mut trace = Trace::default();

        let result = record_step_inputs(&mut trace, &engine, &acked);

        assert_eq!(result, Err(NO_PENDING));
        assert_eq!(trace.acked, vec![String::from("returning")]);
        assert_eq!(trace.replayed, Vec::<String>::new());
    }

    #[test]
    fn a_replayed_ack_after_an_empty_snapshot_reaches_the_checker() {
        use crate::check::{Checker, Guarantee, Violation};

        let id = String::from("returning-on-empty-snapshot");
        let acked = [EventId::new(id.clone()).unwrap()];
        let mut trace = Trace::default();
        // The step starts with no acks and no queue; its applied ack puts
        // the ID back into pending before replay detection runs.
        let engine = engine_with_pending(&[named_event(&id)]);

        record_step_inputs(&mut trace, &engine, &acked).unwrap();

        assert_eq!(trace.acked, vec![id.clone()]);
        assert_eq!(trace.replayed, vec![id.clone()]);
        assert_eq!(
            Checker::check(&trace),
            vec![Violation {
                guarantee: Guarantee::NoAckLostBeforeHalt,
                reason: format!("acked event {id} was redelivered after halt"),
            }]
        );
    }

    #[test]
    fn a_trace_records_only_acks_from_applied_inputs() {
        let mut out = Vec::new();

        let run = simulate_with_trace(Seed::from_u64(1), 3, &mut out).unwrap();

        assert_eq!(
            run.trace.acked,
            vec![String::from("timer:sim:1970-01-01T00:00:01Z")]
        );
        assert_eq!(
            run.trace.printed,
            vec![
                String::from("timer:sim:1970-01-01T00:00:01Z"),
                String::from("timer:sim:1970-01-01T00:00:02Z")
            ]
        );
    }

    #[test]
    fn held_input_ack_then_stop_reaches_the_checker_cleanly() {
        use crate::check::{Checker, Guarantee, Violation};

        let mut out = Vec::new();

        let run = simulate_with_trace(Seed::from_u64(125), 2, &mut out).unwrap();

        assert_eq!(
            run.summary,
            Summary {
                steps: 2,
                events: 1,
                outcome: Outcome::Stopped,
            }
        );
        assert_eq!(
            run.trace.acked,
            vec![String::from("timer:sim:1970-01-01T00:00:01Z")]
        );
        assert_eq!(run.trace.replayed, Vec::<String>::new());

        let ack_loss: Vec<Violation> = Checker::check(&run.trace)
            .into_iter()
            .filter(|violation| {
                violation.guarantee == Guarantee::NoAckLostBeforeHalt
            })
            .collect();

        assert_eq!(ack_loss, Vec::<Violation>::new());
    }

    #[test]
    fn a_full_run_with_acks_and_an_absent_start_queue_is_clean() {
        use crate::check::Checker;

        let mut out = Vec::new();

        // Step 0 has no queue; step 1 applies an ack, so later steps carry
        // acks into replay observation.
        let run = simulate_with_trace(Seed::from_u64(1), 3, &mut out).unwrap();

        assert_eq!(
            run.summary,
            Summary {
                steps: 3,
                events: 2,
                outcome: Outcome::Budget,
            }
        );
        assert_eq!(
            run.trace,
            Trace {
                emitted: vec![
                    String::from("timer:sim:1970-01-01T00:00:01Z"),
                    String::from("timer:sim:1970-01-01T00:00:02Z")
                ],
                printed: vec![
                    String::from("timer:sim:1970-01-01T00:00:01Z"),
                    String::from("timer:sim:1970-01-01T00:00:02Z")
                ],
                acked: vec![String::from("timer:sim:1970-01-01T00:00:01Z")],
                replayed: Vec::new()
            }
        );
        assert_eq!(Checker::check(&run.trace), Vec::new());
    }

    #[test]
    fn an_event_leaving_pending_without_an_ack_is_a_violation() {
        use crate::check::{Checker, Guarantee, Violation};

        let event = named_event("vanished");
        let id = String::from("vanished");
        let mut engine = engine_with_pending(std::slice::from_ref(&event));
        let mut trace = Trace {
            emitted: vec![id.clone()],
            ..Default::default()
        };
        let inputs = ScriptedInputs::new();

        // The event leaves pending outside the applied Ack-input path.
        assert_eq!(engine.ack(std::slice::from_ref(event.id())).unwrap(), 1);
        assert_eq!(engine.pending(), Some(VecDeque::new()));

        record_acked(&mut trace, inputs.acked_ids());

        assert_eq!(trace.acked, Vec::<String>::new());
        assert_eq!(
            Checker::check(&trace),
            vec![Violation {
                guarantee: Guarantee::AtLeastOnceDelivery,
                reason: format!("emitted event {id} was neither printed nor acked"),
            }]
        );
    }
}
