//! `sourcefed-sim` runs a scripted simulation through the real poll engine.

mod args;
mod driver;
mod input;

use std::ffi::OsString;
use std::io;
use std::process::ExitCode;

use crate::args::Args;

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
}
