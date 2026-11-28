use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::Event;

/// Longest time the poll engine waits for one pre-commit verdict.
pub const EVENT_BEFORE_TIMEOUT: Duration = Duration::from_millis(100);

/// The log reason when a hook reports an error.
pub const HOOK_ERROR_REASON: &str = "event-before-error";

/// The log reason when a hook misses the verdict deadline.
pub const HOOK_TIMEOUT_REASON: &str = "event-before-timeout";

/// The log reason when a hook panics before it answers.
pub const HOOK_PANIC_REASON: &str = "event-before-panic";

/// What to do with one event before it is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum BeforeVerdict {
    /// Commit the event.
    Keep,
    /// Leave the event out of the commit; reason says why.
    Drop { reason: String },
}

/// The decision applied to one event before the poll outcome is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BeforeDecision {
    /// Commit the event. reason names a hook failure that kept it, if any.
    Keep { reason: Option<String> },
    /// Leave the event out of the commit; reason says why.
    Drop { reason: String },
}

/// Decides whether an event is committed or left out.
///
/// Hooks are shared across threads, so each one is `Send` and `Sync`.
pub trait EventBefore: Send + Sync {
    /// Returns the verdict for event within the budget.
    ///
    /// # Errors
    /// Returns a message saying why no verdict is available.
    fn verdict(
        &self,
        event: &Event,
        budget: Duration,
    ) -> Result<BeforeVerdict, String>;

    /// Returns whether the hook needs no verdict and can be skipped entirely.
    fn is_passthrough(&self) -> bool {
        false
    }
}

/// An `EventBefore` that keeps every event.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl EventBefore for AllowAll {
    fn verdict(
        &self,
        _event: &Event,
        _budget: Duration,
    ) -> Result<BeforeVerdict, String> {
        Ok(BeforeVerdict::Keep)
    }

    fn is_passthrough(&self) -> bool {
        true
    }
}

// Releases the in-flight slot when a verdict worker ends, even on panic.
struct HookGuard(Arc<AtomicBool>);

impl Drop for HookGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Asks a hook for one verdict within a deadline and applies the policy.
///
/// The hook runs on its own thread, so a hook that never answers yields a
/// timeout decision by the deadline and the caller never waits longer. A
/// second call while a hook is still in flight is rejected with the timeout
/// reason without spawning a thread. A panic keeps the event with the panic
/// reason; an error keeps it with the error reason. A pass-through hook is
/// never spawned.
pub(crate) fn decide_before(
    before: Arc<dyn EventBefore>,
    event: &Event,
    timeout: Duration,
    in_flight: &Arc<AtomicBool>,
) -> BeforeDecision {
    if before.is_passthrough() {
        return BeforeDecision::Keep { reason: None };
    }

    if in_flight
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return BeforeDecision::Keep {
            reason: Some(HOOK_TIMEOUT_REASON.into()),
        };
    }

    let event = event.clone();
    let (sender, receiver) = mpsc::channel();
    let flag = Arc::clone(in_flight);
    let worker =
        thread::Builder::new()
            .name("event-before".into())
            .spawn(move || {
                let _guard = HookGuard(flag);
                let result = before.verdict(&event, timeout);
                let _ = sender.send(result);
            });

    if let Err(error) = worker {
        in_flight.store(false, Ordering::Release);

        return BeforeDecision::Keep {
            reason: Some(format!("{HOOK_ERROR_REASON}: {error}")),
        };
    }

    match receiver.recv_timeout(timeout) {
        Ok(Ok(BeforeVerdict::Keep)) => BeforeDecision::Keep { reason: None },
        Ok(Ok(BeforeVerdict::Drop { reason })) => BeforeDecision::Drop { reason },
        Ok(Err(message)) => BeforeDecision::Keep {
            reason: Some(format!("{HOOK_ERROR_REASON}: {message}")),
        },
        Err(mpsc::RecvTimeoutError::Timeout) => BeforeDecision::Keep {
            reason: Some(HOOK_TIMEOUT_REASON.into()),
        },
        Err(mpsc::RecvTimeoutError::Disconnected) => BeforeDecision::Keep {
            reason: Some(HOOK_PANIC_REASON.into()),
        },
    }
}

// Shared fakes for the hook tests in this module and in poll.rs.
#[cfg(test)]
pub(crate) mod support {
    use std::thread;
    use std::time::Duration;

    use super::{BeforeVerdict, EventBefore};
    use crate::{Event, EventId, EventKind, EventSubject, SourceName};

    /// Builds an event with the given ID and optional author.
    pub(crate) fn event(id: &str, author: Option<&str>) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "subject".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let event = Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            at,
        )
        .unwrap();

        event.with_author(author.map(str::to_owned)).unwrap()
    }

    /// Drops events whose author is bot.
    pub(crate) struct BotFilter;

    impl EventBefore for BotFilter {
        fn verdict(
            &self,
            event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            if event.author() == Some("bot") {
                Ok(BeforeVerdict::Drop {
                    reason: "bot author".into(),
                })
            } else {
                Ok(BeforeVerdict::Keep)
            }
        }
    }

    /// Always reports an error instead of a verdict.
    pub(crate) struct FailingHook;

    impl EventBefore for FailingHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            Err("hook unavailable".into())
        }
    }

    /// Sleeps past any ordinary deadline before answering.
    pub(crate) struct BlockingHook;

    impl EventBefore for BlockingHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            thread::sleep(Duration::from_millis(300));

            Ok(BeforeVerdict::Keep)
        }
    }

    fn panic_now() -> ! {
        panic!("hook panicked");
    }

    /// Panics instead of returning a verdict.
    pub(super) struct PanickingHook;

    impl EventBefore for PanickingHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            panic_now()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::support::{
        BlockingHook, BotFilter, FailingHook, PanickingHook, event,
    };
    use super::*;

    fn in_flight() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn allow_all_is_a_passthrough_that_keeps_every_event() {
        let flag = in_flight();
        let decision = decide_before(
            Arc::new(AllowAll),
            &event("fired", Some("bot")),
            EVENT_BEFORE_TIMEOUT,
            &flag,
        );

        assert_eq!(decision, BeforeDecision::Keep { reason: None });
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[test]
    fn a_hook_can_drop_a_bot_author() {
        let dropped = decide_before(
            Arc::new(BotFilter),
            &event("fired", Some("bot")),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );
        let kept = decide_before(
            Arc::new(BotFilter),
            &event("fired", Some("alice")),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            dropped,
            BeforeDecision::Drop {
                reason: "bot author".into(),
            }
        );
        assert_eq!(kept, BeforeDecision::Keep { reason: None });
    }

    #[test]
    fn an_error_keeps_the_event_with_a_named_reason() {
        let decision = decide_before(
            Arc::new(FailingHook),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(format!("{HOOK_ERROR_REASON}: hook unavailable")),
            }
        );
    }

    #[test]
    fn a_blocking_hook_keeps_the_event_with_a_timeout_reason() {
        let decision = decide_before(
            Arc::new(BlockingHook),
            &event("fired", None),
            Duration::from_millis(50),
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_TIMEOUT_REASON.into()),
            }
        );
    }

    #[test]
    fn a_panicking_hook_keeps_the_event_with_a_panic_reason() {
        let decision = decide_before(
            Arc::new(PanickingHook),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_PANIC_REASON.into()),
            }
        );
    }

    #[test]
    fn a_concurrent_hook_call_is_rejected_without_spawning() {
        let decision = decide_before(
            Arc::new(PanickingHook),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &Arc::new(AtomicBool::new(true)),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_TIMEOUT_REASON.into()),
            }
        );
    }

    #[test]
    fn a_finished_hook_releases_its_in_flight_slot() {
        let flag = in_flight();
        let decision = decide_before(
            Arc::new(BotFilter),
            &event("fired", Some("bot")),
            EVENT_BEFORE_TIMEOUT,
            &flag,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(1);

        while flag.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }

        assert_eq!(
            decision,
            BeforeDecision::Drop {
                reason: "bot author".into(),
            }
        );
        assert!(!flag.load(Ordering::Relaxed));
    }
}
