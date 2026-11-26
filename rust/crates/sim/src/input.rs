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
    pending_acks: usize,
}

impl Inputs {
    /// Starts with no queued inputs.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns whether an acknowledgement is waiting between polls.
    #[must_use]
    pub const fn has_pending_ack(&self) -> bool {
        self.pending_acks > 0
    }

    /// Queues acks for some new events and, at the end, maybe a stop.
    pub fn schedule(&mut self, seed: &mut Seed, events: &[Event], left: u32) {
        for event in events {
            if seed.below(2) == 0 {
                self.queue.push_back(Input::Ack(event.id().clone()));
                self.pending_acks = self.pending_acks.saturating_add(1);
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
            self.pending_acks = self.pending_acks.saturating_sub(1);
        }

        Ok(stopped)
    }

    /// Returns the IDs whose acknowledgements were saved.
    #[must_use]
    pub const fn acked(&self) -> &[EventId] {
        self.acked.as_slice()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use jiff::Timestamp;
    use sourcefed_core::{
        Clock, EventKind, EventSubject, MonitorConfig, MonitorId, PollInterval,
        Source, TimerSource,
    };

    use super::*;
    use crate::clock::SimClock;

    fn event(id: &str) -> Event {
        let source = sourcefed_core::SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "subject".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn engine() -> PollEngine<MemoryStore> {
        let source = TimerSource::new("deploy".into(), 1).unwrap();
        let config = MonitorConfig {
            id: MonitorId::new("sim".into()).unwrap(),
            source: source.name().clone(),
            poll_interval: PollInterval::from_secs(1).unwrap(),
        };
        let shared: Arc<dyn Clock> = Arc::new(SimClock::new(Timestamp::UNIX_EPOCH));

        PollEngine::new(config, Arc::new(source), MemoryStore::new(), shared)
            .unwrap()
    }

    #[test]
    fn schedule_tracks_a_queued_ack() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();
        let mut inputs = Inputs::new();

        inputs.schedule(&mut seed, &[event("e1")], 2);

        assert!(inputs.has_pending_ack());
    }

    #[test]
    fn a_lone_stop_is_not_a_pending_ack() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();
        let mut inputs = Inputs::new();

        inputs.schedule(&mut seed, &[], 1);

        assert!(!inputs.has_pending_ack());
    }

    #[test]
    fn next_input_records_an_applied_ack() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();
        let pending = event("e1");
        let id = pending.id().clone();
        let mut inputs = Inputs::new();
        let mut engine = engine();
        inputs.schedule(&mut seed, &[pending], 2);

        assert!(!inputs.next_input(&mut engine).unwrap());
        assert_eq!(inputs.acked(), &[id]);
        assert!(!inputs.has_pending_ack());
    }

    #[test]
    fn next_input_reports_a_stop_without_an_ack() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();
        let mut inputs = Inputs::new();
        let mut engine = engine();
        inputs.schedule(&mut seed, &[], 1);

        assert!(inputs.next_input(&mut engine).unwrap());
        let expected: Vec<EventId> = Vec::new();
        assert_eq!(inputs.acked(), expected);
        assert!(!inputs.has_pending_ack());
    }
}
