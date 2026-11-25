//! `sourcefed-core` follows a timer and prints its events as JSON lines.

use std::collections::HashSet;
use std::error::Error;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use sourcefed_core::{
    EngineState, EventId, MonitorConfig, MonitorId, PollEngine, PollInterval,
    Source, StopHandle, Store, SystemClock, TimerSource,
};

// One input line holds a command and an event ID of at most 256 bytes.
const MAX_INPUT_LINE: u64 = 512;
// How long the last inputs may take to arrive once a stop is requested.
const DRAIN_WAIT: Duration = Duration::from_secs(1);

#[derive(Parser)]
#[command(name = "sourcefed-core", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Follows a timer and prints each event as one JSON line.
    Follow(Follow),
}

#[derive(Args)]
struct Follow {
    /// The job the timer fires.
    #[arg(long)]
    job: String,
    /// Seconds between firings, from 1 to 3600.
    #[arg(long)]
    every: u64,
    /// The directory that keeps the position and pending events.
    #[arg(long)]
    state_dir: PathBuf,
    /// The most polls this run makes before it exits.
    #[arg(long)]
    max_polls: u32,
}

#[derive(Debug, Eq, PartialEq)]
enum Input {
    Ack(EventId),
    Stop,
}

fn main() -> ExitCode {
    let Command::Follow(args) = Cli::parse().command;

    match follow(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("sourcefed-core: {error}");

            ExitCode::FAILURE
        }
    }
}

fn follow(args: Follow) -> Result<(), Box<dyn Error>> {
    let mut engine = engine(args.job, args.every, &args.state_dir)?;
    let (sender, receiver) = mpsc::channel();
    let stop = engine.handle();
    thread::spawn(move || read_input(io::stdin().lock(), &stop, &sender));

    let mut inputs = Inputs {
        receiver,
        stopped: false,
    };
    let mut printed = HashSet::new();

    for _ in 0..args.max_polls {
        inputs.apply(&mut engine)?;
        let state = engine.run(1)?;
        print_new(&engine, &mut printed)?;

        if state != EngineState::Running {
            break;
        }
    }

    inputs.finish(&mut engine)
}

fn engine(
    job: String,
    every: u64,
    state_dir: &Path,
) -> Result<PollEngine, Box<dyn Error>> {
    let source = TimerSource::new(job.clone(), every)?;
    let config = MonitorConfig {
        id: MonitorId::new(job)?,
        source: source.name().clone(),
        poll_interval: PollInterval::from_secs(every)?,
    };
    let store = Store::open(state_dir)?;
    let engine =
        PollEngine::new(config, Arc::new(source), store, Arc::new(SystemClock))?;

    Ok(engine)
}

fn print_new(
    engine: &PollEngine,
    printed: &mut HashSet<EventId>,
) -> Result<(), Box<dyn Error>> {
    let Some(pending) = engine.pending() else {
        return Ok(());
    };

    let mut out = io::stdout().lock();

    for event in pending {
        if printed.insert(event.id().clone()) {
            writeln!(out, "{}", serde_json::to_string(event)?)?;
        }
    }

    out.flush()?;
    // Acknowledged IDs never return, so only pending ones need remembering.
    printed.retain(|id| pending.iter().any(|event| event.id() == id));

    Ok(())
}

struct Inputs {
    receiver: Receiver<Input>,
    stopped: bool,
}

impl Inputs {
    fn apply(&mut self, engine: &mut PollEngine) -> Result<(), Box<dyn Error>> {
        while let Ok(input) = self.receiver.try_recv() {
            self.handle(engine, input)?;
        }

        Ok(())
    }

    fn finish(&mut self, engine: &mut PollEngine) -> Result<(), Box<dyn Error>> {
        self.apply(engine)?;

        // A stop request is sent before it is flagged, so the acks ahead of
        // it are already queued; wait for them to arrive.
        while engine.handle().is_stopped() && !self.stopped {
            match self.receiver.recv_timeout(DRAIN_WAIT) {
                Ok(input) => self.handle(engine, input)?,
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }

        Ok(())
    }

    fn handle(
        &mut self,
        engine: &mut PollEngine,
        input: Input,
    ) -> Result<(), Box<dyn Error>> {
        match input {
            // An unknown ID removes nothing, so it is left alone.
            Input::Ack(id) => {
                engine.ack(std::slice::from_ref(&id))?;
            }
            Input::Stop => self.stopped = true,
        }

        Ok(())
    }
}

fn read_input(mut reader: impl BufRead, stop: &StopHandle, sender: &Sender<Input>) {
    let mut line = String::new();

    loop {
        line.clear();

        match reader.by_ref().take(MAX_INPUT_LINE).read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) => {
                eprintln!("sourcefed-core: stdin: {error}");

                return;
            }
        }

        let input = match parse_input(&line) {
            Ok(input) => input,
            Err(error) => {
                eprintln!("sourcefed-core: {error}");

                continue;
            }
        };
        let stopping = input == Input::Stop;

        if sender.send(input).is_err() {
            return;
        }

        if stopping {
            stop.stop();
        }
    }
}

fn parse_input(line: &str) -> Result<Input, String> {
    let line = line.trim();

    if line == "stop" {
        return Ok(Input::Stop);
    }

    let Some(id) = line.strip_prefix("ack ") else {
        return Err(format!(
            "unknown input {line:?}; use ack <event-id> or stop"
        ));
    };

    EventId::new(id.trim().to_owned())
        .map(Input::Ack)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use sourcefed_core::{Event, Position, PositionKey, SourceName};

    use super::*;

    const ID: &str = "timer:deploy:2026-01-01T00:00:00Z";

    fn ack(id: &str) -> Input {
        Input::Ack(EventId::new(id.into()).unwrap())
    }

    fn inputs() -> (Sender<Input>, Inputs) {
        let (sender, receiver) = mpsc::channel();

        (
            sender,
            Inputs {
                receiver,
                stopped: false,
            },
        )
    }

    // Saves one pending event under the key `follow` uses for job deploy.
    fn pending_engine(dir: &Path) -> PollEngine {
        let event: Event = serde_json::from_value(serde_json::json!({
            "id": ID,
            "kind": "timer.fired",
            "subject": { "source": "timer", "key": "deploy" },
            "summary": "timer deploy fired at 2026-01-01T00:00:00Z",
            "at": "2026-01-01T00:00:00Z",
        }))
        .unwrap();
        let key = PositionKey {
            monitor: MonitorId::new("deploy".into()).unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        };
        let position = Position::new("2026-01-01T00:00:01Z".into()).unwrap();
        Store::open(dir)
            .unwrap()
            .commit(key, position, &[event])
            .unwrap();

        engine("deploy".into(), 1, dir).unwrap()
    }

    fn pending_ids(engine: &PollEngine) -> Vec<&str> {
        engine
            .pending()
            .into_iter()
            .flatten()
            .map(|event| event.id().as_str())
            .collect()
    }

    #[test]
    fn apply_acks_queued_events_and_ignores_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (sender, mut inputs) = inputs();

        sender.send(ack("timer:deploy:other")).unwrap();
        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), [ID]);

        sender.send(ack(ID)).unwrap();
        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(!inputs.stopped);
    }

    #[test]
    fn finish_applies_acks_ahead_of_a_stop_without_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (sender, mut inputs) = inputs();
        engine.handle().stop();

        sender.send(ack(ID)).unwrap();
        sender.send(Input::Stop).unwrap();
        let started = Instant::now();
        inputs.finish(&mut engine).unwrap();

        assert!(started.elapsed() < DRAIN_WAIT);
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(inputs.stopped);
    }

    #[test]
    fn finish_without_a_stop_request_returns_without_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (_sender, mut inputs) = inputs();

        let started = Instant::now();
        inputs.finish(&mut engine).unwrap();

        assert!(started.elapsed() < DRAIN_WAIT);
        assert_eq!(pending_ids(&engine), [ID]);
        assert!(!inputs.stopped);
    }

    #[test]
    fn read_input_flags_a_stop_only_for_a_stop_line() {
        let stop = StopHandle::default();
        let (sender, receiver) = mpsc::channel();

        read_input(&b"ack first\n"[..], &stop, &sender);

        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [ack("first")]);

        read_input(&b"stop\n"[..], &stop, &sender);

        assert!(stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [Input::Stop]);
    }

    #[test]
    fn parse_input_reads_ack_and_stop_lines() {
        let id = EventId::new("timer:deploy:2026-01-01T00:00:00Z".into());

        assert_eq!(parse_input("stop\n"), Ok(Input::Stop));
        assert_eq!(
            parse_input("ack timer:deploy:2026-01-01T00:00:00Z\n"),
            Ok(Input::Ack(id.unwrap()))
        );
    }

    #[test]
    fn parse_input_rejects_other_lines() {
        assert_eq!(
            parse_input("halt\n"),
            Err(r#"unknown input "halt"; use ack <event-id> or stop"#.into())
        );
        assert_eq!(
            parse_input("ack  \n"),
            Err("unknown input \"ack\"; use ack <event-id> or stop".into())
        );
    }

    #[test]
    fn read_input_sends_inputs_in_order_and_flags_a_stop() {
        let stop = StopHandle::default();
        let (sender, receiver) = mpsc::channel();
        let lines = "ack first\nbogus\nstop\nack later\n";

        read_input(lines.as_bytes(), &stop, &sender);
        drop(sender);

        let ack = |id: &str| Input::Ack(EventId::new(id.into()).unwrap());

        assert!(stop.is_stopped());
        assert_eq!(
            receiver.iter().collect::<Vec<_>>(),
            [ack("first"), Input::Stop, ack("later")]
        );
    }
}
