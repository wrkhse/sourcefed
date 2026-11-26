//! Scripted acknowledgement and stop inputs for one simulation run.

use std::collections::VecDeque;
use std::error::Error;

use sourcefed_cli::{Input, apply_input};
use sourcefed_core::{Event, PollEngine};
use sourcefed_sim::{MemoryStore, Seed};

// Invariant: one run queues at most this many inputs. The final step keeps
// one slot for a stop placed at the front so it applies next.
const MAX_QUEUED: usize = 8;

/// A bounded queue of inputs applied one at a time to the poll engine.
#[derive(Debug)]
pub struct ScriptedInputs {
    queued: VecDeque<Input>,
}

impl Default for ScriptedInputs {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptedInputs {
    /// Creates an empty queue with room for one run's input budget.
    #[must_use]
    pub fn new() -> Self {
        Self {
            queued: VecDeque::with_capacity(MAX_QUEUED),
        }
    }

    /// Queues acks for a seed-chosen subset of `events`, and a stop on the
    /// final step. `left` counts this step, so the stop is queued when it is 1.
    pub fn schedule(&mut self, seed: &mut Seed, events: &[Event], left: u32) {
        let final_step = left == 1;
        let cap = if final_step {
            MAX_QUEUED.saturating_sub(1)
        } else {
            MAX_QUEUED
        };

        for event in events {
            if self.queued.len() >= cap {
                break;
            }

            if seed.next_u64() & 1 == 1 {
                self.queued.push_back(Input::Ack(event.id().clone()));
            }
        }

        if final_step {
            self.queued.push_front(Input::Stop);
        }
    }

    /// Applies one queued input through the path the stdin reader uses.
    ///
    /// Returns whether that input requested a stop; an empty queue does not.
    ///
    /// # Errors
    /// Returns the store's error if an acknowledgement cannot be saved.
    pub fn apply_next(
        &mut self,
        engine: &mut PollEngine<MemoryStore>,
    ) -> Result<bool, Box<dyn Error>> {
        let Some(input) = self.queued.pop_front() else {
            return Ok(false);
        };

        apply_input(engine, input)
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use sourcefed_core::{
        EngineState, EventId, EventKind, EventSubject, SourceName,
    };

    use super::*;
    use crate::driver::engine;

    fn event(index: usize) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "sim".into()).unwrap();

        Event::new(
            EventId::new(format!("event-{index}")).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn ack(index: usize) -> Input {
        Input::Ack(EventId::new(format!("event-{index}")).unwrap())
    }

    fn engine_with_event() -> PollEngine<MemoryStore> {
        let mut engine = engine().unwrap();
        engine.run(1).unwrap();
        engine.run(1).unwrap();
        engine
    }

    #[test]
    fn a_seed_chooses_which_events_are_acked() {
        let mut inputs = ScriptedInputs::new();
        let events: Vec<Event> = (0..4).map(event).collect();
        let expected = [ack(0), ack(1), ack(3)];

        inputs.schedule(&mut Seed::from_u64(1), &events, 4);

        let actual: Vec<_> = inputs.queued.iter().collect();
        assert_eq!(actual, expected.iter().collect::<Vec<_>>());
    }

    #[test]
    fn only_the_final_step_queues_a_stop_within_the_cap() {
        let mut inputs = ScriptedInputs::new();
        let events: Vec<Event> =
            (0..MAX_QUEUED.saturating_add(4)).map(event).collect();

        inputs.schedule(&mut Seed::from_u64(1), &events, 2);

        assert_eq!(inputs.queued.len(), MAX_QUEUED);
        assert!(inputs.queued.iter().all(|i| *i != Input::Stop));

        let mut final_inputs = ScriptedInputs::new();

        final_inputs.schedule(&mut Seed::from_u64(119), &events, 1);

        assert_eq!(final_inputs.queued.len(), MAX_QUEUED);
        assert_eq!(final_inputs.queued.front(), Some(&Input::Stop));
    }

    #[test]
    fn an_ack_removes_an_event_and_a_stop_is_reported() {
        let mut engine = engine_with_event();
        let mut inputs = ScriptedInputs::new();
        let mut pending = engine.pending().unwrap();
        let event = pending.pop_front().unwrap();
        let id = String::from(event.id().as_str());

        inputs.queued.push_back(Input::Ack(event.id().clone()));

        assert!(!inputs.apply_next(&mut engine).unwrap());
        assert_eq!(engine.pending(), Some(VecDeque::new()));
        assert_eq!(id, "timer:sim:1970-01-01T00:00:01Z");

        inputs.queued.push_back(Input::Stop);

        assert!(inputs.apply_next(&mut engine).unwrap());
        assert_eq!(engine.pending(), Some(VecDeque::new()));
        assert_eq!(engine.state(), EngineState::Running);
    }
}
