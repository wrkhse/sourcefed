//! The guarantees a simulation run must satisfy.

use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use jiff::Timestamp;
use sourcefed_core::{DEFAULT_BACKOFF_CAP_SECS, EventId, MAX_WAIT_SECS};

use crate::clock::{ClockFault, SimClock};
use crate::store::MemoryStore;

/// A scripted clock reading and what the engine did with it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClockMark {
    /// The reading the clock was asked to report.
    pub fault: ClockFault,
    /// Commits observed before the reading.
    pub polls_before: usize,
    /// Commits observed after the run that consumed it.
    pub polls_after: usize,
    /// Whether the engine was stopped after that run.
    pub stopped: bool,
}

/// Which durable write was scripted to fail.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreFaultKind {
    /// A poll's commit failed.
    Commit,
    /// An acknowledgement failed.
    Ack,
}

/// What the run emitted, delivered, printed and injected.
#[derive(Debug, Default)]
pub struct Trace {
    tick: u64,
    /// IDs the engine saved as fresh events, in commit order.
    pub emitted: Vec<EventId>,
    /// Printed IDs and the tick when each was printed.
    pub printed: Vec<(EventId, u64)>,
    /// Acknowledged IDs and the tick when each ack was saved.
    pub acked: Vec<(EventId, u64)>,
    /// Acked IDs that reappeared in the engine's pending queue.
    pub replayed: Vec<EventId>,
    /// Scripted readings and the engine's response to each.
    pub clock_faults: Vec<ClockMark>,
    /// Store faults injected during the run.
    pub store_faults: Vec<StoreFaultKind>,
    /// Sleep durations requested by the engine.
    pub sleeps: Vec<Duration>,
    /// Virtual time at the start of the run.
    pub start: Option<Timestamp>,
    /// Seconds added to virtual time outside sleeps.
    pub advance_secs: u64,
    /// Commits observed in the run.
    pub polls: usize,
    /// How many steps the run was given.
    pub steps: u32,
    /// The timer interval in seconds.
    pub interval_secs: u64,
}

impl Trace {
    /// Starts a trace for a run with the given virtual start and timer.
    #[must_use]
    pub fn new(start: Timestamp, steps: u32, interval_secs: u64) -> Self {
        Self {
            start: Some(start),
            steps,
            interval_secs,
            ..Self::default()
        }
    }

    /// Records an ID the engine saved as a fresh event.
    pub fn emit(&mut self, id: &EventId) {
        self.emitted.push(id.clone());
    }

    /// Records an acked ID that reappeared in pending.
    pub fn replay(&mut self, id: &EventId) {
        self.replayed.push(id.clone());
    }

    /// Records an ID written to stdout.
    pub fn print(&mut self, id: &EventId) {
        self.bump();
        self.printed.push((id.clone(), self.tick));
    }

    /// Records an ID whose acknowledgement was saved.
    pub fn ack(&mut self, id: &EventId) {
        self.bump();
        self.acked.push((id.clone(), self.tick));
    }

    const fn bump(&mut self) {
        self.tick = self.tick.saturating_add(1);
    }
}

/// A guarantee the run failed, with a short reason.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Violation {
    /// An emitted event was neither printed nor acknowledged.
    AtLeastOnceDelivery { id: String, reason: String },
    /// An acknowledged event was printed again, replayed or left pending.
    NoAckLostBeforeHalt { id: String, reason: String },
    /// An out-of-range reading did not fail closed like the real clock.
    ClockFaultsFailClosed { fault: ClockFault, reason: String },
    /// Simulated sleeps or poll lateness left their bounds.
    PollsOnTimeInSimulatedTime { reason: String },
    /// An unacknowledged pending event is absent after a restart.
    RedeliveryAfterRestart { reason: String },
}

impl Violation {
    /// Returns the guarantee's name.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::AtLeastOnceDelivery { .. } => "at-least-once delivery",
            Self::NoAckLostBeforeHalt { .. } => "no ack lost before halt",
            Self::ClockFaultsFailClosed { .. } => "clock faults fail closed",
            Self::PollsOnTimeInSimulatedTime { .. } => {
                "polls on time in simulated time"
            }
            Self::RedeliveryAfterRestart { .. } => "redelivery after restart",
        }
    }

    /// Returns the short reason the guarantee failed.
    #[must_use]
    pub fn reason(&self) -> &str {
        match self {
            Self::AtLeastOnceDelivery { reason, .. }
            | Self::NoAckLostBeforeHalt { reason, .. }
            | Self::ClockFaultsFailClosed { reason, .. }
            | Self::PollsOnTimeInSimulatedTime { reason }
            | Self::RedeliveryAfterRestart { reason } => reason,
        }
    }
}

impl fmt::Display for Violation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.name(), self.reason())
    }
}

impl std::error::Error for Violation {}

/// Checks a completed trace against the guarantees it can prove.
#[derive(Clone, Copy, Debug, Default)]
pub struct Checker;

impl Checker {
    /// Returns each violated guarantee, in check order.
    ///
    /// Checks at-least-once delivery, no ack lost before halt, clock faults
    /// fail closed, and polls on time. Bounded cleanup belongs to the PR 4
    /// pinned seeds.
    #[must_use]
    pub fn check(
        trace: &Trace,
        clock: &SimClock,
        store: &MemoryStore,
    ) -> Vec<Violation> {
        let mut violations = Vec::new();

        Self::check_delivery(trace, store, &mut violations);
        Self::check_clock(trace, &mut violations);
        Self::check_sleeps(trace, clock, &mut violations);

        violations
    }

    /// Compares IDs pending before a restart with what the restart printed.
    #[must_use]
    pub fn check_restart(
        before: &[EventId],
        printed: &HashSet<EventId>,
        acked: &[EventId],
        trace: &mut Trace,
    ) -> Vec<Violation> {
        let mut violations = Vec::new();

        for id in before {
            let redelivered = printed.contains(id);

            if acked.contains(id) {
                if redelivered {
                    trace.replay(id);
                    violations.push(Violation::RedeliveryAfterRestart {
                        reason: "acked event was redelivered after restart".into(),
                    });
                }

                continue;
            }

            if !redelivered {
                violations.push(Violation::RedeliveryAfterRestart {
                    reason: "pending event absent after restart".into(),
                });
            }
        }

        violations
    }

    fn check_delivery(trace: &Trace, store: &MemoryStore, out: &mut Vec<Violation>) {
        for id in &trace.emitted {
            let printed = trace.printed.iter().any(|(value, _)| value == id);
            let acked = trace.acked.iter().any(|(value, _)| value == id);

            // An ack saved before any print is a delivered event too.
            if !printed && !acked {
                out.push(Violation::AtLeastOnceDelivery {
                    id: id.as_str().to_owned(),
                    reason: "emitted event was neither printed nor acked".into(),
                });
            }
        }

        for (id, at) in &trace.acked {
            let replayed = trace
                .printed
                .iter()
                .any(|(value, tick)| value == id && tick > at);

            if replayed {
                out.push(Violation::NoAckLostBeforeHalt {
                    id: id.as_str().to_owned(),
                    reason: "acked event was printed again".into(),
                });
            } else if trace.replayed.contains(id) {
                out.push(Violation::NoAckLostBeforeHalt {
                    id: id.as_str().to_owned(),
                    reason: "acked event reappeared in pending".into(),
                });
            } else if store.is_pending(id) {
                out.push(Violation::NoAckLostBeforeHalt {
                    id: id.as_str().to_owned(),
                    reason: "acked event is still pending".into(),
                });
            }
        }
    }

    fn check_clock(trace: &Trace, out: &mut Vec<Violation>) {
        for mark in &trace.clock_faults {
            match mark.fault {
                ClockFault::Ok => {}
                ClockFault::Past => {
                    if !mark.stopped {
                        out.push(Violation::ClockFaultsFailClosed {
                            fault: mark.fault,
                            reason: "past reading left the engine running".into(),
                        });
                    }
                }
                ClockFault::Future => {
                    if mark.polls_after != mark.polls_before {
                        out.push(Violation::ClockFaultsFailClosed {
                            fault: mark.fault,
                            reason: "future reading polled while deferred".into(),
                        });
                    }
                }
            }
        }
    }

    fn check_sleeps(trace: &Trace, clock: &SimClock, out: &mut Vec<Violation>) {
        let per_step = DEFAULT_BACKOFF_CAP_SECS
            .div_ceil(MAX_WAIT_SECS)
            .saturating_add(1);
        let budget = u64::from(trace.steps)
            .saturating_mul(per_step)
            .saturating_mul(MAX_WAIT_SECS);
        let mut total = 0_u64;

        for sleep in &trace.sleeps {
            let secs = sleep.as_secs();

            if secs > MAX_WAIT_SECS {
                out.push(Violation::PollsOnTimeInSimulatedTime {
                    reason: "a sleep exceeded the wait cap".into(),
                });
            }

            total = total.saturating_add(secs);
        }

        if total > budget {
            out.push(Violation::PollsOnTimeInSimulatedTime {
                reason: "total sleeps exceeded the step budget".into(),
            });
        }

        let Some(start) = trace.start else {
            return;
        };

        Self::check_accounting(trace, clock, start, total, out);
        Self::check_lateness(trace, clock, start, per_step, out);
    }

    // Virtual time moves only through a logged sleep or a recorded advance.
    fn check_accounting(
        trace: &Trace,
        clock: &SimClock,
        start: Timestamp,
        slept: u64,
        out: &mut Vec<Violation>,
    ) {
        let elapsed = slept.saturating_add(trace.advance_secs);
        let expected = start
            .checked_add(Duration::from_secs(elapsed))
            .unwrap_or(Timestamp::MAX);

        if clock.virtual_now() != expected {
            out.push(Violation::PollsOnTimeInSimulatedTime {
                reason: "virtual time moved without a sleep or advance".into(),
            });
        }
    }

    fn check_lateness(
        trace: &Trace,
        clock: &SimClock,
        start: Timestamp,
        per_step: u64,
        out: &mut Vec<Violation>,
    ) {
        if trace.polls == 0 {
            return;
        }

        let done = u64::try_from(trace.polls.saturating_sub(1)).unwrap_or(u64::MAX);
        let scheduled = done.saturating_mul(trace.interval_secs);
        let due = start
            .checked_add(Duration::from_secs(scheduled))
            .unwrap_or(Timestamp::MAX);
        let now = clock.virtual_now();

        if now < due {
            out.push(Violation::PollsOnTimeInSimulatedTime {
                reason: "a poll happened before its due time".into(),
            });
        }

        let faults = u64::try_from(trace.clock_faults.len()).unwrap_or(u64::MAX);
        let slack = per_step
            .saturating_mul(MAX_WAIT_SECS)
            .saturating_add(faults.saturating_mul(MAX_WAIT_SECS))
            .saturating_add(trace.advance_secs);
        let limit = due
            .checked_add(Duration::from_secs(slack))
            .unwrap_or(Timestamp::MAX);

        if now > limit {
            out.push(Violation::PollsOnTimeInSimulatedTime {
                reason: "lateness accumulated beyond the wait budget".into(),
            });
        }
    }
}
#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use sourcefed_core::Clock;
    use sourcefed_core::store::StateStore;
    use sourcefed_core::{
        Event, EventId, EventKind, EventSubject, MAX_WAIT_SECS, MonitorId, Position,
        PositionKey, SourceName,
    };

    use super::*;
    use crate::clock::SimClock;

    fn event(id: &str) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "subject".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn key() -> PositionKey {
        PositionKey {
            monitor: MonitorId::new("sim".into()).unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        }
    }

    fn clock() -> SimClock {
        SimClock::new(Timestamp::UNIX_EPOCH)
    }

    #[test]
    fn an_emitted_event_that_is_never_printed_violates_delivery() {
        let mut trace = Trace::default();
        trace.emit(event("e1").id());

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::AtLeastOnceDelivery {
                id: "e1".into(),
                reason: "emitted event was neither printed nor acked".into(),
            }]
        );
    }

    #[test]
    fn a_printed_emitted_event_satisfies_delivery() {
        let emitted = event("e1");
        let mut trace = Trace::default();
        trace.emit(emitted.id());
        trace.print(emitted.id());

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_replayed_ack_violates_no_ack_lost() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();
        trace.ack(&id);
        trace.replay(&id);

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::NoAckLostBeforeHalt {
                id: "e1".into(),
                reason: "acked event reappeared in pending".into(),
            }]
        );
    }

    #[test]
    fn a_print_after_ack_violates_no_ack_lost() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();
        trace.ack(&id);
        trace.print(&id);

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::NoAckLostBeforeHalt {
                id: "e1".into(),
                reason: "acked event was printed again".into(),
            }]
        );
    }

    #[test]
    fn a_pending_ack_violates_no_ack_lost() {
        let pending = event("e1");
        let id = pending.id().clone();
        let mut store = MemoryStore::new();
        let position = Position::new("1".into()).unwrap();

        assert_eq!(
            store
                .commit(key(), position, std::slice::from_ref(&pending))
                .unwrap(),
            1
        );

        let mut trace = Trace::default();
        trace.ack(&id);

        let violations = Checker::check(&trace, &clock(), &store);

        assert_eq!(
            violations,
            vec![Violation::NoAckLostBeforeHalt {
                id: "e1".into(),
                reason: "acked event is still pending".into(),
            }]
        );
    }

    #[test]
    fn an_ok_reading_produces_no_clock_violation() {
        let mut trace = Trace::default();
        trace.clock_faults.push(ClockMark {
            fault: ClockFault::Ok,
            polls_before: 1,
            polls_after: 2,
            stopped: false,
        });

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn an_event_printed_then_acked_produces_no_violation() {
        let emitted = event("e1");
        let mut trace = Trace::default();
        trace.emit(emitted.id());
        trace.print(emitted.id());
        trace.ack(emitted.id());

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_past_reading_that_keeps_running_fails_the_clock_check() {
        let mut trace = Trace::default();
        trace.clock_faults.push(ClockMark {
            fault: ClockFault::Past,
            polls_before: 0,
            polls_after: 0,
            stopped: false,
        });

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::ClockFaultsFailClosed {
                fault: ClockFault::Past,
                reason: "past reading left the engine running".into(),
            }]
        );
    }

    #[test]
    fn a_stopped_past_reading_satisfies_the_clock_check() {
        let mut trace = Trace::default();
        trace.clock_faults.push(ClockMark {
            fault: ClockFault::Past,
            polls_before: 0,
            polls_after: 0,
            stopped: true,
        });

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_future_reading_that_polls_fails_the_clock_check() {
        let mut trace = Trace::default();
        trace.clock_faults.push(ClockMark {
            fault: ClockFault::Future,
            polls_before: 1,
            polls_after: 2,
            stopped: false,
        });

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::ClockFaultsFailClosed {
                fault: ClockFault::Future,
                reason: "future reading polled while deferred".into(),
            }]
        );
    }

    #[test]
    fn a_sleep_over_the_wait_cap_fails_the_timing_check() {
        let clock = clock();
        let duration = Duration::from_secs(MAX_WAIT_SECS.saturating_add(1));
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 1, 1);
        clock.sleep(duration);
        trace.sleeps.push(duration);

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::PollsOnTimeInSimulatedTime {
                reason: "a sleep exceeded the wait cap".into(),
            }]
        );
    }

    #[test]
    fn sleeps_past_the_step_budget_fail_the_timing_check() {
        let clock = clock();
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 1, 1);

        for _ in 0..32 {
            clock.sleep(Duration::from_secs(MAX_WAIT_SECS));
            trace.sleeps.push(Duration::from_secs(MAX_WAIT_SECS));
        }

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::PollsOnTimeInSimulatedTime {
                reason: "total sleeps exceeded the step budget".into(),
            }]
        );
    }

    #[test]
    fn virtual_time_without_a_sleep_or_advance_fails_the_timing_check() {
        let clock = clock();
        clock.advance(5);
        let trace = Trace::new(Timestamp::UNIX_EPOCH, 1, 1);

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::PollsOnTimeInSimulatedTime {
                reason: "virtual time moved without a sleep or advance".into(),
            }]
        );
    }

    #[test]
    fn a_poll_before_its_due_time_fails_the_timing_check() {
        let clock = clock();
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 2, 10);
        trace.polls = 2;

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::PollsOnTimeInSimulatedTime {
                reason: "a poll happened before its due time".into(),
            }]
        );
    }

    #[test]
    fn lateness_past_the_wait_budget_fails_the_timing_check() {
        let clock = clock();
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 2, 10);

        for _ in 0..40 {
            clock.sleep(Duration::from_secs(MAX_WAIT_SECS));
            trace.sleeps.push(Duration::from_secs(MAX_WAIT_SECS));
        }

        trace.polls = 1;

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::PollsOnTimeInSimulatedTime {
                reason: "lateness accumulated beyond the wait budget".into(),
            }]
        );
    }

    #[test]
    fn an_ack_that_reappears_after_restart_is_recorded_as_a_replay() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();

        let printed = HashSet::from([id.clone()]);
        let violations = Checker::check_restart(
            &[],
            &printed,
            std::slice::from_ref(&id),
            &mut trace,
        );

        assert_eq!(
            violations,
            vec![Violation::RedeliveryAfterRestart {
                reason: "acked event was redelivered after restart".into(),
            }]
        );
        assert_eq!(trace.replayed, vec![id]);
    }

    #[test]
    fn an_unacked_pending_id_absent_after_restart_violates_redelivery() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();

        let violations =
            Checker::check_restart(&[id], &HashSet::new(), &[], &mut trace);

        assert_eq!(
            violations,
            vec![Violation::RedeliveryAfterRestart {
                reason: "pending event absent after restart".into(),
            }]
        );
        assert_eq!(violations[0].reason(), "pending event absent after restart");
    }

    #[test]
    fn an_acked_id_absent_after_restart_is_not_a_violation() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();

        let before = std::slice::from_ref(&id);
        let violations =
            Checker::check_restart(before, &HashSet::new(), before, &mut trace);

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_pending_id_still_present_after_restart_is_not_a_violation() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();

        let printed = HashSet::from([id.clone()]);
        let violations = Checker::check_restart(
            std::slice::from_ref(&id),
            &printed,
            &[],
            &mut trace,
        );

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn every_unacked_pending_id_must_appear_in_the_restart_printed_set() {
        let first = event("e1").id().clone();
        let second = event("e2").id().clone();
        let mut trace = Trace::default();
        let printed = HashSet::from([first.clone()]);

        let violations =
            Checker::check_restart(&[first, second], &printed, &[], &mut trace);

        assert_eq!(
            violations,
            vec![Violation::RedeliveryAfterRestart {
                reason: "pending event absent after restart".into(),
            }]
        );
    }

    #[test]
    fn an_acked_id_in_the_restart_printed_set_violates_redelivery() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();
        let printed = HashSet::from([id.clone()]);

        let violations = Checker::check_restart(
            &[],
            &printed,
            std::slice::from_ref(&id),
            &mut trace,
        );

        assert_eq!(
            violations,
            vec![Violation::RedeliveryAfterRestart {
                reason: "acked event was redelivered after restart".into(),
            }]
        );
        assert_eq!(trace.replayed, vec![id]);
    }

    #[test]
    fn the_five_proven_guarantees_have_distinct_names() {
        let id = "e1".to_owned();
        let guarantees = [
            Violation::AtLeastOnceDelivery {
                id: id.clone(),
                reason: String::new(),
            },
            Violation::NoAckLostBeforeHalt {
                id,
                reason: String::new(),
            },
            Violation::ClockFaultsFailClosed {
                fault: ClockFault::Ok,
                reason: String::new(),
            },
            Violation::PollsOnTimeInSimulatedTime {
                reason: String::new(),
            },
            Violation::RedeliveryAfterRestart {
                reason: String::new(),
            },
        ];
        let names: Vec<_> = guarantees.iter().map(Violation::name).collect();

        assert_eq!(
            names,
            vec![
                "at-least-once delivery",
                "no ack lost before halt",
                "clock faults fail closed",
                "polls on time in simulated time",
                "redelivery after restart",
            ]
        );
    }

    #[test]
    fn every_violation_reports_its_exact_reason_and_display() {
        let id = "e1".to_owned();
        let cases = [
            (
                Violation::AtLeastOnceDelivery {
                    id: id.clone(),
                    reason: "delivery reason".into(),
                },
                "delivery reason",
                "at-least-once delivery: delivery reason",
            ),
            (
                Violation::NoAckLostBeforeHalt {
                    id,
                    reason: "ack reason".into(),
                },
                "ack reason",
                "no ack lost before halt: ack reason",
            ),
            (
                Violation::ClockFaultsFailClosed {
                    fault: ClockFault::Past,
                    reason: "clock reason".into(),
                },
                "clock reason",
                "clock faults fail closed: clock reason",
            ),
            (
                Violation::PollsOnTimeInSimulatedTime {
                    reason: "poll reason".into(),
                },
                "poll reason",
                "polls on time in simulated time: poll reason",
            ),
            (
                Violation::RedeliveryAfterRestart {
                    reason: "restart reason".into(),
                },
                "restart reason",
                "redelivery after restart: restart reason",
            ),
        ];

        for (violation, reason, rendered) in cases {
            assert_eq!(violation.reason(), reason);
            assert_eq!(violation.to_string(), rendered);
        }
    }

    #[test]
    fn only_the_unprinted_emitted_id_violates_delivery() {
        let printed = event("p1");
        let missing = event("m1");
        let mut trace = Trace::default();
        trace.emit(printed.id());
        trace.emit(missing.id());
        trace.print(printed.id());

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::AtLeastOnceDelivery {
                id: "m1".into(),
                reason: "emitted event was neither printed nor acked".into(),
            }]
        );
    }

    #[test]
    fn only_the_unacked_emitted_id_violates_delivery() {
        let acked = event("a1");
        let missing = event("m1");
        let mut trace = Trace::default();
        trace.emit(acked.id());
        trace.emit(missing.id());
        trace.ack(acked.id());

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        assert_eq!(
            violations,
            vec![Violation::AtLeastOnceDelivery {
                id: "m1".into(),
                reason: "emitted event was neither printed nor acked".into(),
            }]
        );
    }

    #[test]
    fn a_print_at_the_ack_tick_is_not_a_replay() {
        let id = event("e1").id().clone();
        let mut trace = Trace::default();
        trace.printed.push((id.clone(), 7));
        trace.acked.push((id, 7));

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_later_print_of_another_id_is_not_a_replay() {
        let acked = event("a1").id().clone();
        let later = event("b1").id().clone();
        let mut trace = Trace::default();
        trace.acked.push((acked, 1));
        trace.printed.push((later, 2));

        let violations = Checker::check(&trace, &clock(), &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_poll_exactly_at_its_due_time_is_on_time() {
        let clock = clock();
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 1, 10);
        trace.polls = 1;

        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }

    #[test]
    fn a_poll_exactly_at_the_slack_limit_is_on_time() {
        let clock = clock();
        let mut trace = Trace::new(Timestamp::UNIX_EPOCH, 1, 10);
        let limit = MAX_WAIT_SECS.saturating_mul(31);

        for _ in 0..31 {
            clock.sleep(Duration::from_secs(MAX_WAIT_SECS));
            trace.sleeps.push(Duration::from_secs(MAX_WAIT_SECS));
        }

        trace.polls = 1;
        let expected = Timestamp::UNIX_EPOCH
            .checked_add(Duration::from_secs(limit))
            .unwrap();

        assert_eq!(clock.virtual_now(), expected);
        let violations = Checker::check(&trace, &clock, &MemoryStore::new());

        let expected: Vec<Violation> = Vec::new();
        assert_eq!(violations, expected);
    }
}
