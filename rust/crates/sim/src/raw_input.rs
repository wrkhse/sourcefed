//! Raw stdin input driven through the real CLI reader and finish paths.

#![cfg(test)]

use std::error::Error;
use std::io::{self, Cursor};
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_cli::sim_seam::HoldGate;
use sourcefed_cli::{
    Input, Inputs, ReaderState, input_channel, parse_input, read_input,
};
use sourcefed_core::{
    MonitorConfig, MonitorId, PollEngine, PollInterval, Source, StopHandle,
    TimerSource,
};
use sourcefed_sim::{MemoryStore, SimClock};

use crate::check::{Checker, Trace};

const WAIT: Duration = Duration::from_secs(3);
// The gated reader holds the handoff lock, so `finish` cannot apply the ack
// until the gate is released. There is no public hook for "finish halted
// the reader", so a short delay is the only way to let the halt land first
// without a new production seam. Releasing sooner would queue the ack instead
// of leaving it held; a stuck gate fails through `WAIT` rather than hanging.
const HANDOFF: Duration = Duration::from_millis(50);

/// A run whose stdin is fed as raw bytes through the real CLI reader.
struct RawRun {
    engine: Option<PollEngine<MemoryStore>>,
    inputs: Option<Inputs>,
    stop: StopHandle,
    sender: SyncSender<Input>,
    state: Arc<ReaderState>,
    trace: Trace,
    acked: Vec<String>,
}

impl RawRun {
    /// Builds a real engine, its input channel, and an empty trace.
    ///
    /// # Errors
    /// Returns the validation error if the engine cannot be built.
    fn new() -> Result<Self, Box<dyn Error>> {
        let engine = engine()?;
        let stop = engine.handle();
        let (sender, receiver) = input_channel();
        let state = Arc::new(ReaderState::default());
        let inputs = Inputs::new(receiver, Arc::clone(&state));

        Ok(Self {
            engine: Some(engine),
            inputs: Some(inputs),
            stop,
            sender,
            state,
            trace: Trace::default(),
            acked: Vec::new(),
        })
    }

    /// Feeds raw bytes through the real stdin reader.
    fn feed(&mut self, bytes: &[u8]) {
        // Publish only the acks the reader accepted: a line it discards as
        // over-long is not an ack the agent sent. Observe the reader's own
        // inputs, then forward them to the run's queue for `poll`/`finish`.
        let (observed, received) = input_channel();

        read_input(Cursor::new(bytes), &self.stop, &self.state, &observed);
        drop(observed);

        for input in received {
            if let Input::Ack(id) = &input {
                self.record_published(id.as_str());
            }

            if self.sender.send(input).is_err() {
                break;
            }
        }
    }

    /// Applies queued inputs, polls once, and records what was observed.
    ///
    /// # Errors
    /// Returns the input or engine error that ends the step.
    fn poll(&mut self) -> Result<(), Box<dyn Error>> {
        let engine = self.engine.as_mut().ok_or_else(|| missing("engine"))?;
        let inputs = self.inputs.as_mut().ok_or_else(|| missing("inputs"))?;

        inputs.apply(engine)?;
        engine.run(1)?;
        let pending = self.pending_ids();

        self.record_emitted(&pending);

        Ok(())
    }

    /// Drains the reader through the real finish path and observes it.
    ///
    /// # Errors
    /// Returns the input or store error that ends the run.
    fn finish(&mut self) -> Result<(), Box<dyn Error>> {
        let engine = self.engine.as_mut().ok_or_else(|| missing("engine"))?;
        let inputs = self.inputs.as_mut().ok_or_else(|| missing("inputs"))?;

        inputs.finish(engine)?;
        let pending = self.pending_ids();

        self.record_emitted(&pending);
        self.record_replayed(&pending);

        Ok(())
    }

    /// Holds one ack at the parse-to-claim handoff and halts there.
    ///
    /// # Errors
    /// Returns a channel, thread, or finish error.
    fn held_ack_at_halt(&mut self, id: &str) -> Result<(), Box<dyn Error>> {
        let (entered, entered_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let mut reader = ReaderState::default();
        reader.set_hold_gate(HoldGate::new(entered, resume_rx));
        let state = Arc::new(reader);
        let (sender, receiver) = input_channel();

        self.sender = sender.clone();
        self.state = Arc::clone(&state);
        self.inputs = Some(Inputs::new(receiver, Arc::clone(&state)));

        let line = format!("ack {id}\n");

        if let Ok(Input::Ack(published)) = parse_input(&line) {
            self.record_published(published.as_str());
        }

        let read_state = Arc::clone(&state);
        let stop = self.stop.clone();
        let (read_tx, read_rx) = mpsc::channel();

        thread::spawn(move || {
            read_input(Cursor::new(line), &stop, &read_state, &sender);
            let _ = read_tx.send(());
        });
        entered_rx.recv_timeout(WAIT)?;

        let watchdog = thread::spawn(move || {
            thread::sleep(HANDOFF);
            let _ = resume.send(());
        });

        let engine = self.engine.as_mut().ok_or_else(|| missing("engine"))?;
        let inputs = self.inputs.as_mut().ok_or_else(|| missing("inputs"))?;

        inputs.finish(engine)?;
        watchdog
            .join()
            .map_err(|_| io::Error::other("gate release panicked"))?;
        read_rx.recv_timeout(WAIT)?;

        let pending = self.pending_ids();

        self.record_emitted(&pending);
        self.record_replayed(&pending);

        Ok(())
    }

    /// Returns the observations this run recorded.
    #[must_use]
    const fn trace(&self) -> &Trace {
        &self.trace
    }

    fn pending_ids(&self) -> Vec<String> {
        let Some(engine) = self.engine.as_ref() else {
            return Vec::new();
        };

        engine
            .pending()
            .into_iter()
            .flatten()
            .map(|event| String::from(event.id().as_str()))
            .collect()
    }

    // An ack on a fed line is published by the agent, whether or not the
    // engine ends up applying it. A dropped ack stays visible to the checker.
    fn record_published(&mut self, id: &str) {
        let id = String::from(id);

        if !self.acked.contains(&id) {
            self.acked.push(id.clone());
            self.trace.acked.push(id.clone());
            self.trace.printed.push(id);
        }
    }

    fn record_emitted(&mut self, pending: &[String]) {
        for id in pending {
            if !self.trace.emitted.contains(id) {
                self.trace.emitted.push(id.clone());
            }
        }
    }

    // A published ack still pending is delivered again after a restart.
    fn record_replayed(&mut self, pending: &[String]) {
        for id in &self.acked {
            if pending.contains(id) && !self.trace.replayed.contains(id) {
                self.trace.replayed.push(id.clone());
            }
        }
    }
}

fn missing(field: &'static str) -> Box<dyn Error> {
    Box::from(io::Error::other(format!("raw run has no {field}")))
}

fn engine() -> Result<PollEngine<MemoryStore>, Box<dyn Error>> {
    let timer = TimerSource::new("sim".into(), 1)?;
    let config = MonitorConfig {
        id: MonitorId::new("sim".into())?,
        source: timer.name().clone(),
        poll_interval: PollInterval::from_secs(1)?,
    };
    let clock = Arc::new(SimClock::new(Timestamp::UNIX_EPOCH));

    Ok(PollEngine::new(
        config,
        Arc::new(timer),
        MemoryStore::new(),
        clock,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "timer:sim:1970-01-01T00:00:01Z";

    // The first poll sets the timer position; the second emits one event.
    fn with_pending() -> RawRun {
        let mut run = RawRun::new().unwrap();
        run.poll().unwrap();
        run.poll().unwrap();

        run
    }

    #[test]
    fn a_normal_ack_line_from_the_real_reader_is_applied() {
        let mut run = with_pending();
        let line = format!("ack {ID}\n");

        run.feed(line.as_bytes());
        run.finish().unwrap();

        assert_eq!(run.trace().emitted, [ID]);
        assert_eq!(run.trace().acked, [ID]);
        assert_eq!(run.trace().printed, [ID]);
        assert_eq!(run.trace().replayed, Vec::<String>::new());
        assert_eq!(Checker::check(run.trace()), Vec::new());
    }

    #[test]
    fn a_held_ack_is_applied_when_the_run_halts_in_the_handoff() {
        let mut run = with_pending();

        run.held_ack_at_halt(ID).unwrap();

        assert_eq!(run.trace().emitted, [ID]);
        assert_eq!(run.trace().acked, [ID]);
        assert_eq!(run.trace().printed, [ID]);
        assert_eq!(run.trace().replayed, Vec::<String>::new());
        assert_eq!(Checker::check(run.trace()), Vec::new());
    }

    #[test]
    fn an_overlong_line_is_discarded_and_the_next_ack_applied() {
        let mut run = with_pending();
        // Spaces pad the line past the reader's byte limit but trim to a
        // valid, different ack: if the reader ignored its limit, that extra
        // ack would be published and the assertions below would fail.
        let other = "timer:sim:1970-01-01T00:00:02Z";
        let pad = " ".repeat(600);
        let lines = format!("ack {pad}{other}\nack {ID}\n");

        run.feed(lines.as_bytes());
        run.finish().unwrap();

        assert_eq!(run.trace().emitted, [ID]);
        assert_eq!(run.trace().acked, [ID]);
        assert_eq!(run.trace().printed, [ID]);
        assert_eq!(run.trace().replayed, Vec::<String>::new());
        assert_eq!(Checker::check(run.trace()), Vec::new());
    }
}
