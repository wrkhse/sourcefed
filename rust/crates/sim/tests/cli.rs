//! Runs the simulator binary through its real command line.

use std::process::Command;

#[test]
fn an_unknown_argument_exits_with_failure() {
    let output = Command::new(env!("CARGO_BIN_EXE_sourcefed-sim"))
        .arg("--bogus")
        .output()
        .unwrap();

    let stderr = String::from_utf8(output.stderr).unwrap();

    assert!(!output.status.success());
    assert_eq!(
        stderr,
        "sourcefed-sim: unknown argument \"--bogus\"; \
         use --seed <hex> --steps <u32>\n"
    );
}

#[test]
fn the_summary_reports_the_commit_from_the_environment() {
    let output = Command::new(env!("CARGO_BIN_EXE_sourcefed-sim"))
        .args(["--seed", "0000000000000001", "--steps", "1"])
        .env("SOURCEFED_SIM_COMMIT", "sim-commit")
        .output()
        .unwrap();

    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let reported = format!("{stdout}{stderr}");

    assert!(reported.contains("commit=sim-commit"));
}
