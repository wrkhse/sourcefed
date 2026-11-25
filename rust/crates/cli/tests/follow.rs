//! Runs the built binary against a real state directory and the system clock.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

#[test]
fn an_acknowledged_event_is_never_printed_again_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let follow = |max_polls: u32| {
        Command::new(env!("CARGO_BIN_EXE_sourcefed-core"))
            .args(["follow", "--job", "deploy", "--every", "1"])
            .arg("--state-dir")
            .arg(dir.path())
            .args(["--max-polls", &max_polls.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    };
    // Reads until the child closes stdout, which it does when it exits.
    let remaining_ids = |stdout: &mut dyn BufRead| -> Vec<String> {
        stdout
            .lines()
            .map(|line| {
                let event: Value = serde_json::from_str(&line.unwrap()).unwrap();

                event["id"].as_str().unwrap().to_owned()
            })
            .collect()
    };

    // The first poll saves the next firing and the second prints it, so eight
    // one-second polls end the run in about seven seconds even if no event
    // ever arrives.
    let mut first = follow(8);
    let mut stdout = BufReader::new(first.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();

    let event: Value = serde_json::from_str(&line).unwrap();
    let id = event["id"].as_str().unwrap().to_owned();
    let at = event["at"].as_str().unwrap();

    assert_eq!(id, format!("timer:deploy:{at}"));
    assert_eq!(event["kind"], "timer.fired");
    assert_eq!(
        event["subject"],
        json!({ "source": "timer", "key": "deploy" })
    );
    assert_eq!(event["summary"], format!("timer deploy fired at {at}"));

    let mut stdin = first.stdin.take().unwrap();
    writeln!(stdin, "ack {id}").unwrap();
    writeln!(stdin, "stop").unwrap();
    drop(stdin);
    let stopping = Instant::now();

    let rest = remaining_ids(&mut stdout);

    assert!(first.wait().unwrap().success());
    // The six polls left after the first event would take about six seconds;
    // a stop ends the run within one.
    assert!(stopping.elapsed() < Duration::from_secs(3));
    assert!(!rest.contains(&id));

    let seen: HashSet<String> = rest.into_iter().chain([id.clone()]).collect();

    // The saved position resumes the timer, so the second run prints firings
    // the first never saw, and never the one it acknowledged.
    let mut second = follow(3);
    drop(second.stdin.take());
    let mut stdout = BufReader::new(second.stdout.take().unwrap());
    let printed = remaining_ids(&mut stdout);
    let fresh = printed.iter().filter(|printed| !seen.contains(*printed));

    assert!(second.wait().unwrap().success());
    assert!(!printed.contains(&id));
    assert_ne!(fresh.count(), 0);
}
