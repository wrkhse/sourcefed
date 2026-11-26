//! `sourcefed-core` follows a timer and prints its events as JSON lines.

use std::collections::HashSet;
use std::error::Error;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use clap::{Args, Parser, Subcommand};
use sourcefed_cli::{Inputs, ReaderState, input_channel, read_input};
use sourcefed_core::{EngineState, EventId, PollEngine};

#[derive(Parser)]
#[command(name = "sourcefed-core", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Follows a timer and prints each event as one JSON line. Each poll
    /// reads a bounded number of ack and stop lines from stdin; a line over
    /// 512 bytes is discarded with a diagnostic. If it runs another 65536
    /// bytes without a newline, the reader logs discard-bound-exceeded and
    /// discards the remainder in bounded chunks. A newline within the
    /// remainder discard's first mebibyte lets later ack and stop lines
    /// reach the reader unless the discarded-line budget is exhausted. The
    /// byte cap ends stdin reading with discard-total-cap-reached. The
    /// reader also logs discard-line-budget-exhausted and stops after
    /// discarding 64 over-long lines without sending an input. A successful
    /// input send resets the count; an invalid input does not.
    /// An ack sent while sourcefed-core is stopping may be ignored; its event
    /// is delivered again on the next run.
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
    let mut engine = sourcefed_cli::engine(args.job, args.every, &args.state_dir)?;
    let (sender, receiver) = input_channel();
    let stop = engine.handle();
    let reader = Arc::new(ReaderState::default());
    let state = Arc::clone(&reader);

    thread::spawn(move || {
        read_input(io::stdin().lock(), &stop, &state, &sender);
    });

    let mut inputs = Inputs::new(receiver, reader);
    let mut printed = HashSet::new();

    for _ in 0..args.max_polls {
        inputs.apply(&mut engine)?;
        let state = engine.run(1)?;
        print_new(&engine, &mut printed)?;

        if state != EngineState::Running {
            break;
        }
    }

    inputs.finish(&mut engine)?;

    Ok(())
}

fn print_new(
    engine: &PollEngine,
    printed: &mut HashSet<EventId>,
) -> Result<(), Box<dyn Error>> {
    let Some(pending) = engine.pending() else {
        return Ok(());
    };

    let mut out = io::stdout().lock();

    for event in &pending {
        if printed.insert(event.id().clone()) {
            writeln!(out, "{}", serde_json::to_string(event)?)?;
        }
    }

    out.flush()?;
    // Acknowledged IDs never return, so only pending ones need remembering.
    printed.retain(|id| pending.iter().any(|event| event.id() == id));

    Ok(())
}
