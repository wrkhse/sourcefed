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
// The reader's own output queue. `feed` drains it only after the reader
// returns, and a script can yield more inputs than the shared input channel
// holds, so this exact bound keeps the reader from blocking on a full queue.
const READER_QUEUE: usize = 4096;

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
        // The reader runs to the end of the script before this queue is
        // drained, so it gets its own channel with the larger `READER_QUEUE`
        // bound instead of the shared input channel's smaller one.
        let (observed, received) = mpsc::sync_channel(READER_QUEUE);

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

        let read_state = Arc::clone(&state);
        let stop = self.stop.clone();
        let (read_tx, read_rx) = mpsc::channel();
        let reader_line = line.clone();

        let read_thread = thread::spawn(move || {
            read_input(Cursor::new(reader_line), &stop, &read_state, &sender);
            let _ = read_tx.send(());
        });
        entered_rx.recv_timeout(WAIT)?;

        let mut engine = self.engine.take().ok_or_else(|| missing("engine"))?;
        let mut inputs = self.inputs.take().ok_or_else(|| missing("inputs"))?;
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let finish_thread = thread::spawn(move || {
            // Signals before finish runs, while the reader is still gated.
            let _ = started_tx.send(());
            let result = inputs.finish(&mut engine).map_err(|e| e.to_string());
            let _ = finished_tx.send((result, engine));
        });

        started_rx.recv_timeout(WAIT)?;

        // finish started while the reader was in the gate: the reader has
        // neither returned nor has the harness observed a published ack.
        // Either observation here means the gate was released too early,
        // so the test would prove nothing.
        assert!(read_rx.try_recv().is_err(), "reader left the gate early");
        assert!(self.acked.is_empty(), "an ack was published while gated");

        // A reader halted inside the gate never publishes to its output
        // channel: `finish` applies the held input through `close_held`.
        // Derive the ID from the line the real reader parsed, not from a
        // separate guess, so the trace records the ack the agent actually sent.
        if let Ok(Input::Ack(published)) = parse_input(&line) {
            self.record_published(published.as_str());
        }

        resume
            .send(())
            .map_err(|_| io::Error::other("gate resume channel closed"))?;

        let (result, finished_engine) = finished_rx.recv_timeout(WAIT)?;
        read_thread
            .join()
            .map_err(|_| io::Error::other("reader panicked"))?;
        finish_thread
            .join()
            .map_err(|_| io::Error::other("finish panicked"))?;
        result.map_err(io::Error::other)?;

        self.engine = Some(finished_engine);
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
