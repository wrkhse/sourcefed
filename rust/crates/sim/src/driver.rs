//! Bounded simulation of the real poll engine with scripted inputs.

use std::collections::HashSet;
use std::error::Error;
use std::io::Write;
use std::sync::Arc;

use jiff::Timestamp;
use sourcefed_core::{
    EngineState, EventId, MonitorConfig, MonitorId, PollEngine, PollInterval,
    Source, TimerSource,
};
use sourcefed_sim::{MemoryStore, Seed, SimClock};

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

/// Builds a real engine over a timer, the virtual clock and memory store.
///
/// # Errors
/// Returns the validation error when the monitor, interval or engine cannot
/// be built.
pub fn engine() -> Result<PollEngine<MemoryStore>, String> {
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
pub fn simulate(
    seed: Seed,
    steps: u32,
    out: &mut impl Write,
) -> Result<Summary, Box<dyn Error>> {
    let mut engine = engine()?;
    let mut inputs = ScriptedInputs::new();
    let mut printed = HashSet::new();
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
        let pending: Vec<_> = match engine.pending() {
            Some(pending) => {
                let fresh = print_new(&engine, &mut printed, out)?;
                events = events.saturating_add(fresh);
                pending.into()
            }
            None if index == 0 => Vec::new(),
            None => return Err(NO_PENDING.into()),
        };

        inputs.schedule(&mut draw, &pending, left);

        let stopped = if left == 1 {
            inputs.apply_all(&mut engine)?
        } else {
            inputs.apply_next(&mut engine)?
        };

        forget_acked(&engine, &mut printed);

        if stopped {
            outcome = Outcome::Stopped;
            break;
        }
    }

    Ok(Summary {
        steps: taken,
        events,
        outcome,
    })
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
}
