//! Runs the built binary against a real state directory and the system clock.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::iter;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// One poll takes a second; leave room for a slow CI runner.
const SHORT_WAIT: Duration = Duration::from_secs(5);
/// The second run prints several events, so it gets a longer bound.
const LONG_WAIT: Duration = Duration::from_secs(30);

/// Owns a spawned child so every path reaps it: on drop the child is killed
/// (errors ignored) and waited on (errors ignored), even if the test panics.
struct ChildGuard(Child);

impl ChildGuard {
    fn stdin(&mut self) -> Option<ChildStdin> {
        self.0.stdin.take()
    }

    fn stdout(&mut self) -> Option<ChildStdout> {
        self.0.stdout.take()
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.0.wait()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Owns the line receiver together with the reader thread's handle.
///
/// On a panic path the `JoinHandle` is dropped, which detaches the thread;
/// the `ChildGuard` then kills the child, so the reader sees EOF and exits
/// instead of being left running.
struct LineEvents {
    rx: Receiver<String>,
    handle: JoinHandle<()>,
}

impl LineEvents {
    /// Joins the reader thread once the stream has ended.
    fn join(self) {
        self.handle.join().unwrap();
    }
}

/// Reads a child's stdout on a thread, returning the receiver and the thread's
/// handle wrapped in a `LineEvents`. The sender drops at EOF (or on a read
/// error), which the receiver observes as a disconnect: the end of the stream.
fn line_receiver(reader: impl BufRead + Send + 'static) -> LineEvents {
    let (tx, rx) = mpsc::channel();

    let handle = thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };

            if tx.send(line).is_err() {
                break;
            }
        }
    });

    LineEvents { rx, handle }
}

/// Receives one line before `deadline`, failing fast instead of blocking.
fn recv_line(rx: &Receiver<String>, deadline: Instant, description: &str) -> String {
    let timeout = deadline.saturating_duration_since(Instant::now());

    match rx.recv_timeout(timeout) {
        Ok(line) => line,
        Err(RecvTimeoutError::Timeout) => {
            panic!("timed out waiting for {description} within {timeout:?}");
        }
        Err(RecvTimeoutError::Disconnected) => {
            panic!("stdout closed before {description} arrived");
        }
    }
}

/// Collects event IDs until the stream ends or `deadline` passes.
fn remaining_ids(rx: &Receiver<String>, deadline: Instant) -> Vec<String> {
    let mut ids = Vec::new();

    loop {
        let timeout = deadline.saturating_duration_since(Instant::now());

        if timeout.is_zero() {
            break;
        }

        match rx.recv_timeout(timeout) {
            Ok(line) => {
                let event: Value = serde_json::from_str(&line).unwrap();
                ids.push(event["id"].as_str().unwrap().to_owned());
            }
            Err(RecvTimeoutError::Disconnected) | Err(RecvTimeoutError::Timeout) => {
                break;
            }
        }
    }

    ids
}

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

    // The first poll saves the next firing and each later one prints a
    // firing, so sixteen one-second polls keep the run going for about
    // fifteen seconds unless a stop ends it.
    let mut first = ChildGuard(follow(16));
    let stdout = BufReader::new(first.stdout().unwrap());
    let events = line_receiver(stdout);

    let line = recv_line(&events.rx, Instant::now() + SHORT_WAIT, "the first event");
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
    let line = recv_line(&events.rx, Instant::now() + SHORT_WAIT, "the second event");
    let later: Value = serde_json::from_str(&line).unwrap();
    let later = later["id"].as_str().unwrap().to_owned();

    let mut stdin = first.stdin().unwrap();
    writeln!(stdin, "ack {id}").unwrap();
    writeln!(stdin, "stop").unwrap();
    drop(stdin);
    let stopping = Instant::now();

    let rest = remaining_ids(&events.rx, Instant::now() + SHORT_WAIT);

    assert!(first.wait().unwrap().success());
    events.join();
    // The polls left after the second event would take about thirteen
    // seconds. A stop ends the run within one poll, with room for a slow
    // machine.
    assert!(stopping.elapsed() < Duration::from_secs(3));
    assert!(!rest.contains(&id));

    // What the first run printed and never acknowledged, oldest first.
    let unacknowledged: Vec<String> = iter::once(later).chain(rest).collect();
    let seen: HashSet<&String> = unacknowledged.iter().chain([&id]).collect();

    // The saved position resumes the timer, so the second run prints firings
    // the first never saw, and never the one it acknowledged. The pending
    // events are saved too, so it prints each unacknowledged one again, once
    // and in the same order.
    let mut second = ChildGuard(follow(3));
    drop(second.stdin());
    let stdout = BufReader::new(second.stdout().unwrap());
    let events = line_receiver(stdout);
    let printed = remaining_ids(&events.rx, Instant::now() + LONG_WAIT);
    let fresh = printed.iter().filter(|printed| !seen.contains(*printed));
    let again: Vec<&String> = printed
        .iter()
        .filter(|printed| unacknowledged.contains(*printed))
        .collect();

    assert!(second.wait().unwrap().success());
    events.join();
    assert!(!printed.contains(&id));
    assert_eq!(again, unacknowledged.iter().collect::<Vec<_>>());
    assert_ne!(fresh.count(), 0);
}
