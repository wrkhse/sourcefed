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

    /// Returns whether the input at the front is an acknowledgement.
    #[must_use]
    pub fn front_is_ack(&self) -> bool {
        self.has_pending_ack() && matches!(self.queue.front(), Some(Input::Ack(_)))
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

        let attempt = match &input {
            Input::Ack(id) => Input::Ack(id.clone()),
            Input::Stop => Input::Stop,
        };
        let stopped = match apply_input(engine, attempt) {
            Ok(stopped) => stopped,
            Err(error) => {
                // A failed input keeps its place at the front for a retry.
                self.queue.push_front(input);

                return Err(error);
            }
        };

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
        Source, StoreError, TimerSource,
    };

    use super::*;
    use crate::clock::SimClock;
    use crate::store::StoreControl;

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
        engine_with_control().0
    }

    fn engine_with_control() -> (PollEngine<MemoryStore>, Arc<StoreControl>) {
        let source = TimerSource::new("deploy".into(), 1).unwrap();
        let config = MonitorConfig {
            id: MonitorId::new("sim".into()).unwrap(),
            source: source.name().clone(),
            poll_interval: PollInterval::from_secs(1).unwrap(),
        };
        let shared: Arc<dyn Clock> = Arc::new(SimClock::new(Timestamp::UNIX_EPOCH));
        let store = MemoryStore::new();
        let control = store.control();
        let engine =
            PollEngine::new(config, Arc::new(source), store, shared).unwrap();

        (engine, control)
    }

    #[test]
    fn schedule_tracks_a_queued_ack() {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
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
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
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
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
        let mut inputs = Inputs::new();
        let mut engine = engine();
        inputs.schedule(&mut seed, &[], 1);

        assert!(inputs.next_input(&mut engine).unwrap());
        let expected: Vec<EventId> = Vec::new();
        assert_eq!(inputs.acked(), expected);
        assert!(!inputs.has_pending_ack());
    }

    #[test]
    fn a_failed_ack_is_requeued_and_succeeds_on_a_second_call() {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
        let pending = event("e1");
        let id = pending.id().clone();
        let mut inputs = Inputs::new();
        let (mut engine, control) = engine_with_control();
        inputs.schedule(&mut seed, &[pending], 2);

        control.fail_next_ack();
        let error = inputs.next_input(&mut engine).unwrap_err();
        let write = error
            .downcast_ref::<StoreError>()
            .is_some_and(|cause| matches!(cause, StoreError::Write { .. }));

        assert!(write);
        assert!(inputs.front_is_ack());
        assert!(inputs.has_pending_ack());
        let expected: Vec<EventId> = Vec::new();
        assert_eq!(inputs.acked(), expected);

        assert!(!inputs.next_input(&mut engine).unwrap());
        assert_eq!(inputs.acked(), &[id]);
        assert!(!inputs.has_pending_ack());
    }

    #[test]
    fn front_is_ack_requires_an_ack_at_the_front() {
        let mut stop_first = Inputs::new();
        stop_first.queue.push_back(Input::Stop);
        stop_first
            .queue
            .push_back(Input::Ack(event("e1").id().clone()));
        stop_first.pending_acks = 2;

        assert!(!stop_first.front_is_ack());

        let mut ack_first = Inputs::new();
        ack_first
            .queue
            .push_back(Input::Ack(event("e2").id().clone()));
        ack_first.queue.push_back(Input::Stop);
        ack_first.pending_acks = 2;

        assert!(ack_first.front_is_ack());
    }

    #[test]
    fn schedule_with_steps_left_never_queues_a_stop() {
        let mut seed = Seed::from_hex("0000000000000002").unwrap();
        let mut inputs = Inputs::new();

        inputs.schedule(&mut seed, &[], 2);

        assert!(inputs.queue.is_empty());
    }

    #[test]
    fn schedule_queues_a_stop_only_on_an_even_draw() {
        let mut even = Seed::from_hex("0000000000000002").unwrap();
        let mut stop = Inputs::new();
        stop.schedule(&mut even, &[], 1);

        assert_eq!(stop.queue, VecDeque::from(vec![Input::Stop]));

        let mut odd = Seed::from_hex("0000000000000001").unwrap();
        let mut none = Inputs::new();
        none.schedule(&mut odd, &[], 1);

        assert!(none.queue.is_empty());
    }
}
