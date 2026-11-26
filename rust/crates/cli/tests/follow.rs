//! Runs the built binary against a real state directory and the system clock.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::iter;
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

    // The first poll saves the next firing and each later one prints a
    // firing, so sixteen one-second polls keep the run going for about
    // fifteen seconds unless a stop ends it.
    let mut first = follow(16);
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

    // The next firing is printed too, and is never acknowledged.
    line.clear();
    stdout.read_line(&mut line).unwrap();

    let later: Value = serde_json::from_str(&line).unwrap();
    let later = later["id"].as_str().unwrap().to_owned();

    let mut stdin = first.stdin.take().unwrap();
    writeln!(stdin, "ack {id}").unwrap();
    writeln!(stdin, "stop").unwrap();
    drop(stdin);
    let stopping = Instant::now();

    let rest = remaining_ids(&mut stdout);

    assert!(first.wait().unwrap().success());
    // The polls left after the second event would take about thirteen
    // seconds. A stop ends the run within one, and the bound leaves a slow
    // machine room.
    assert!(stopping.elapsed() < Duration::from_secs(10));
    assert!(!rest.contains(&id));

    // What the first run printed and never acknowledged, oldest first.
    let unacknowledged: Vec<String> = iter::once(later).chain(rest).collect();
    let seen: HashSet<&String> = unacknowledged.iter().chain([&id]).collect();

    // The saved position resumes the timer, so the second run prints firings
    // the first never saw, and never the one it acknowledged. The pending
    // events are saved too, so it prints each unacknowledged one again, once
    // and in the same order.
    let mut second = follow(3);
    drop(second.stdin.take());
    let mut stdout = BufReader::new(second.stdout.take().unwrap());
    let printed = remaining_ids(&mut stdout);
    let fresh = printed.iter().filter(|printed| !seen.contains(*printed));
    let again: Vec<&String> = printed
        .iter()
        .filter(|printed| unacknowledged.contains(*printed))
        .collect();

    assert!(second.wait().unwrap().success());
    assert!(!printed.contains(&id));
    assert_eq!(again, unacknowledged.iter().collect::<Vec<_>>());
    assert_ne!(fresh.count(), 0);
}
