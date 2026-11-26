//! Scripted inputs applied through the CLI's single input path.

use std::collections::VecDeque;
use std::error::Error;

use sourcefed_cli::{Input, apply_input};
use sourcefed_core::{Event, EventId, PollEngine};

use crate::seed::Seed;
use crate::store::MemoryStore;

/// The inputs a run will apply, chosen from the seed.
#[derive(Debug, Default)]
pub struct Inputs {
    queue: VecDeque<Input>,
    acked: Vec<EventId>,
}

impl Inputs {
    /// Starts with no queued inputs.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns whether an input is waiting between polls.
    #[must_use]
    pub fn has_queued(&self) -> bool {
        !self.queue.is_empty()
    }

    /// Queues acks for some new events and, at the end, maybe a stop.
    pub fn schedule(&mut self, seed: &mut Seed, events: &[Event], left: u32) {
        for event in events {
            if seed.below(2) == 0 {
                self.queue.push_back(Input::Ack(event.id().clone()));
            }
        }

        if left == 1 && seed.below(2) == 0 {
            self.queue.push_back(Input::Stop);
        }
    }

    /// Applies the next queued input and returns whether a stop was requested.
    ///
    /// # Errors
    /// Returns the CLI's error when an acknowledgement cannot be saved.
    pub fn next_input(
        &mut self,
        engine: &mut PollEngine<MemoryStore>,
    ) -> Result<bool, Box<dyn Error>> {
        let Some(input) = self.queue.pop_front() else {
            return Ok(false);
        };
        let id = match &input {
            Input::Ack(id) => Some(id.clone()),
            Input::Stop => None,
        };

        let stopped = apply_input(engine, input)?;

        if let Some(id) = id {
            self.acked.push(id);
        }

        Ok(stopped)
    }

    /// Returns the IDs whose acknowledgements were saved.
    #[must_use]
    pub const fn acked(&self) -> &[EventId] {
        self.acked.as_slice()
    }
}
