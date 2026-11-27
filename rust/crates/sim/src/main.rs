//! `sourcefed-sim` runs a scripted simulation through the real poll engine.

mod args;
mod check;
mod driver;
mod input;

use std::ffi::OsString;
use std::io;
use std::process::ExitCode;

use crate::args::Args;
use crate::check::Checker;

const PREFIX: &str = "sourcefed-sim:";
const NON_UTF8: &str = "argument is not valid UTF-8";

fn main() -> ExitCode {
    let options = match collect_args(std::env::args_os()) {
        Ok(options) => options,
        Err(error) => return fail(&error),
    };
    let parsed = match Args::parse(&options) {
        Ok(parsed) => parsed,
        Err(error) => return fail(&error),
    };

    let mut out = io::stdout().lock();

    match driver::simulate_with_trace(parsed.seed, parsed.steps, &mut out) {
        Ok(run) => report(parsed.seed, &run),
        Err(error) => fail(&error.to_string()),
    }
}

fn report(seed: sourcefed_sim::Seed, run: &driver::Run) -> ExitCode {
    let violations = Checker::check(&run.trace);
    let commit = commit();

    for violation in &violations {
        eprintln!("{PREFIX} seed={seed} commit={commit} violation={violation}");
    }

    if violations.is_empty() {
        eprintln!("{PREFIX} {:?}", run.summary);

        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn commit() -> String {
    std::env::var("SOURCEFED_COMMIT").unwrap_or_else(|_| String::from("local"))
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{PREFIX} {message}");

    ExitCode::FAILURE
}

/// Collects the arguments after the program name as UTF-8.
///
/// # Errors
/// Names the first argument that is not valid Unicode.
fn collect_args(
    args: impl Iterator<Item = OsString>,
) -> Result<Vec<String>, String> {
    args.skip(1)
        .map(|arg| arg.into_string().map_err(|_| String::from(NON_UTF8)))
        .collect()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::ffi::OsStringExt;

    use super::*;

    #[test]
    #[cfg(unix)]
    fn a_non_unicode_argument_is_rejected_without_panicking() {
        let args = vec![
            OsString::from("sourcefed-sim"),
            OsString::from_vec(vec![0xFF]),
        ];

        let error = collect_args(args.into_iter()).unwrap_err();

        assert_eq!(error, NON_UTF8);
    }

    #[test]
    fn commit_returns_the_configured_commit() {
        let expected = std::env::var("SOURCEFED_COMMIT")
            .unwrap_or_else(|_| String::from("local"));

        assert_eq!(commit(), expected);
    }

    #[test]
    fn a_violating_report_fails_and_a_clean_report_succeeds() {
        use crate::check::Trace;
        use crate::driver::{Outcome, Summary};
        use sourcefed_sim::Seed;

        let seed = Seed::from_u64(1);
        let summary = Summary {
            steps: 1,
            events: 0,
            outcome: Outcome::Budget,
        };
        let clean = driver::Run {
            summary,
            trace: Trace::default(),
        };
        let violating = driver::Run {
            summary,
            trace: Trace {
                emitted: vec![String::from("lost")],
                ..Default::default()
            },
        };

        assert_eq!(report(seed, &clean), ExitCode::SUCCESS);
        assert_eq!(report(seed, &violating), ExitCode::FAILURE);
    }
}
