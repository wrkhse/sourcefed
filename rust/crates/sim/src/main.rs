//! `sourcefed-sim` runs a scripted simulation through the real poll engine.

mod args;
mod driver;
mod input;

use std::io;
use std::process::ExitCode;

use crate::args::Args;

const PREFIX: &str = "sourcefed-sim:";

fn main() -> ExitCode {
    let options: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match Args::parse(&options) {
        Ok(parsed) => parsed,
        Err(error) => return fail(&error),
    };

    let mut out = io::stdout().lock();

    match driver::simulate(parsed.seed, parsed.steps, &mut out) {
        Ok(summary) => {
            eprintln!("{PREFIX} {summary:?}");
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error.to_string()),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{PREFIX} {message}");

    ExitCode::FAILURE
}
