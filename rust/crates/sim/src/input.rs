//! Scripted acknowledgement and stop inputs for one simulation run.

use std::collections::VecDeque;
use std::error::Error;

use sourcefed_cli::{Input, apply_input};
use sourcefed_core::{Event, EventId, PollEngine};
use sourcefed_sim::{MemoryStore, Seed};

// Invariant: one run queues at most this many inputs. A final-step stop takes
// the last slot so acks queued in earlier steps apply first.
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

    /// Queues acks for a seed-chosen subset of `events`. On the final step a
    /// seed draw also decides whether a stop goes at the back of the queue.
    /// `left` counts this step, so the final step is the one where it is 1.
    pub fn schedule(&mut self, seed: &mut Seed, events: &[Event], left: u32) {
        let final_step = left == 1;
        let stop = final_step && seed.below(2) == 0;
        let cap = if stop {
            MAX_QUEUED.saturating_sub(1)
        } else {
            MAX_QUEUED
        };

        for event in events {
            if self.queued.len() >= cap {
                break;
            }

            if seed.next_u64() & 1 == 1 && !self.has_ack(event.id()) {
                self.queued.push_back(Input::Ack(event.id().clone()));
            }
        }

        if stop && self.queued.len() < MAX_QUEUED {
            self.queued.push_back(Input::Stop);
        }
    }

    fn has_ack(&self, id: &EventId) -> bool {
        self.queued
            .iter()
            .any(|input| matches!(input, Input::Ack(queued) if queued == id))
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

    /// Returns whether no input is waiting.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.queued.is_empty()
    }

    /// Applies queued inputs in order, stopping only after a Stop input.
    ///
    /// Returns whether a stop was requested. Inputs after a Stop stay queued.
    ///
    /// # Errors
    /// Returns the store's error if an acknowledgement cannot be saved.
    pub fn apply_all(
        &mut self,
        engine: &mut PollEngine<MemoryStore>,
    ) -> Result<bool, Box<dyn Error>> {
        let mut stopped = false;

        while !self.is_empty() {
            if self.apply_next(engine)? {
                stopped = true;
                break;
            }
        }

        Ok(stopped)
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
    fn the_cap_holds_with_a_trailing_stop_or_no_stop() {
        let mut inputs = ScriptedInputs::new();
        let events: Vec<Event> =
            (0..MAX_QUEUED.saturating_add(4)).map(event).collect();

        inputs.schedule(&mut Seed::from_u64(425), &events, 2);

        assert_eq!(inputs.queued.len(), MAX_QUEUED);
        assert!(inputs.queued.iter().all(|i| *i != Input::Stop));

        let mut final_inputs = ScriptedInputs::new();
        let mut seed = Seed::from_u64(1);
        let _ = seed.next_u64();
        let _ = seed.next_u64();

        final_inputs.schedule(&mut seed, &events, 1);

        assert_eq!(final_inputs.queued.len(), MAX_QUEUED);
        assert_eq!(final_inputs.queued.back(), Some(&Input::Stop));
        assert_eq!(
            final_inputs
                .queued
                .iter()
                .filter(|input| **input == Input::Stop)
                .count(),
            1
        );
    }

    #[test]
    fn a_trailing_stop_follows_the_queued_acks() {
        let mut engine = engine_with_event();
        let mut inputs = ScriptedInputs::new();
        let mut pending = engine.pending().unwrap();
        let event = pending.pop_front().unwrap();

        inputs.queued.push_back(Input::Ack(event.id().clone()));
        inputs.queued.push_back(Input::Stop);

        assert!(inputs.apply_all(&mut engine).unwrap());
        assert!(inputs.is_empty());
        assert_eq!(engine.pending(), Some(VecDeque::new()));
    }

    #[test]
    fn no_stop_is_queued_when_the_stop_draw_is_odd() {
        let mut inputs = ScriptedInputs::new();
        let events: Vec<Event> = (0..4).map(event).collect();

        inputs.schedule(&mut Seed::from_u64(1), &events, 1);

        assert_eq!(
            inputs.queued.into_iter().collect::<Vec<_>>(),
            vec![ack(0), ack(2), ack(3)]
        );
    }

    #[test]
    fn scheduling_the_same_event_twice_queues_one_ack() {
        let mut inputs = ScriptedInputs::new();
        let events = [event(0)];
        let mut seed = Seed::from_u64(1);

        inputs.schedule(&mut seed, &events, 4);
        inputs.schedule(&mut seed, &events, 4);

        assert_eq!(inputs.queued.into_iter().collect::<Vec<_>>(), vec![ack(0)]);
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
