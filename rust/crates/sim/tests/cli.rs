//! The built simulation binary is deterministic and rejects bad arguments.

use std::io;
use std::process::{Command, Output};

fn run(args: &[&str]) -> io::Result<Output> {
    Command::new(env!("CARGO_BIN_EXE_sourcefed-sim"))
        .args(args)
        .output()
}

#[test]
fn the_same_seed_prints_the_same_events_twice() {
    let argv = ["--seed", "0000000000000001", "--steps", "8"];
    let first = run(&argv).unwrap();
    let second = run(&argv).unwrap();

    assert!(first.status.success());
    assert!(second.status.success());
    assert_eq!(first.stdout, second.stdout);
    assert_ne!(first.stdout, Vec::<u8>::new());
}

#[test]
fn an_invalid_argument_exits_with_failure() {
    let output = run(&["--seed", "xyz", "--steps", "4"]).unwrap();

    assert!(!output.status.success());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "sourcefed-sim: invalid --seed: seed has a non-hex digit\n"
    );
}
