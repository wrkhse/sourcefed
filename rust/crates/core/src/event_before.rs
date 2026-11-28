use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::Event;

/// Longest time the poll engine spends on pre-commit verdicts in one commit.
///
/// The engine divides this budget among the commit's events, passing the
/// remaining time to each hook call. Once it elapses, later events are kept
/// without consulting the hook.
pub const EVENT_BEFORE_TIMEOUT: Duration = Duration::from_millis(100);

/// The log reason when a hook reports an error.
pub const HOOK_ERROR_REASON: &str = "event-before-error";

/// The log reason when a verdict hook is already running on another call.
pub const HOOK_BUSY_REASON: &str = "event-before-busy";

/// The log reason when a hook misses the verdict deadline.
pub const HOOK_TIMEOUT_REASON: &str = "event-before-timeout";

/// The log reason when a hook panics before it answers.
pub const HOOK_PANIC_REASON: &str = "event-before-panic";

/// The log reason when connecting to the hook peer fails.
pub const HOOK_CONNECT_REASON: &str = "event-before-connect";

/// The log reason when decoding a hook reply fails.
pub const HOOK_DECODE_REASON: &str = "event-before-decode";

/// The log reason when the hook peer closes the connection.
pub const HOOK_PEER_CLOSED_REASON: &str = "event-before-peer-closed";

/// The log reason when the reply version does not match.
pub const HOOK_VERSION_REASON: &str = "event-before-version-mismatch";

/// The log reason when the reply call ID does not match.
pub const HOOK_ID_REASON: &str = "event-before-id-mismatch";

/// The log reason when the reply carries an unknown outcome kind.
pub const HOOK_UNKNOWN_OUTCOME_REASON: &str = "event-before-unknown-outcome";

/// The log reason when a rewrite outcome is refused.
pub const HOOK_REWRITE_REFUSED_REASON: &str = "event-before-rewrite-refused";

/// The log reason when a hook's annotation fields fail validation.
pub const HOOK_ANNOTATIONS_REASON: &str = "event-before-annotations-invalid";

/// The log reason when the daemon reports an error.
pub const HOOK_DAEMON_ERROR_REASON: &str = "event-before-daemon-error";

/// What to do with one event before it is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum BeforeVerdict {
    /// Commit the event.
    Keep,
    /// Leave the event out of the commit; reason says why.
    Drop { reason: String },
    /// Commit the event with the given fields applied as annotations.
    Annotate { fields: BTreeMap<String, String> },
}

/// The decision applied to one event before the poll outcome is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BeforeDecision {
    /// Commit the event. reason names a hook failure that kept it, if any;
    /// annotations holds validated fields for the engine to apply.
    Keep {
        reason: Option<String>,
        annotations: BTreeMap<String, String>,
    },
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

// A hook that already names its failure supplies the reason verbatim. Other
// messages are reported under the generic hook error reason.
fn hook_error_reason(message: &str) -> String {
    if message.starts_with("event-before-") {
        message.to_owned()
    } else {
        format!("{HOOK_ERROR_REASON}: {message}")
    }
}

/// Asks a hook for one verdict within a deadline and applies the policy.
///
/// The hook runs on its own thread, so a hook that never answers yields a
/// timeout decision by the deadline and the caller never waits longer. A
/// second call while a hook is still in flight is rejected with the busy
/// reason without spawning a thread. A zero budget keeps the event with the
/// timeout reason without claiming the in-flight slot or spawning a thread.
/// A panic keeps the event with the panic reason; an error keeps it with the
/// error reason. A pass-through hook is never spawned.
pub(crate) fn decide_before(
    before: Arc<dyn EventBefore>,
    event: &Event,
    timeout: Duration,
    in_flight: &Arc<AtomicBool>,
) -> BeforeDecision {
    if before.is_passthrough() {
        return BeforeDecision::Keep {
            reason: None,
            annotations: BTreeMap::new(),
        };
    }

    if timeout.is_zero() {
        return BeforeDecision::Keep {
            reason: Some(HOOK_TIMEOUT_REASON.into()),
            annotations: BTreeMap::new(),
        };
    }

    if in_flight
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return BeforeDecision::Keep {
            reason: Some(HOOK_BUSY_REASON.into()),
            annotations: BTreeMap::new(),
        };
    }

    let event = event.clone();
    let (sender, receiver) = mpsc::channel();
    let flag = Arc::clone(in_flight);
    let worker =
        thread::Builder::new()
            .name("event-before".into())
            .spawn(move || {
                let guard = HookGuard(flag);
                let result = before.verdict(&event, timeout);
                drop(guard);

                let _ = sender.send(result);
            });

    if let Err(error) = worker {
        in_flight.store(false, Ordering::Release);

        return BeforeDecision::Keep {
            reason: Some(hook_error_reason(&error.to_string())),
            annotations: BTreeMap::new(),
        };
    }

    match receiver.recv_timeout(timeout) {
        Ok(Ok(BeforeVerdict::Keep)) => BeforeDecision::Keep {
            reason: None,
            annotations: BTreeMap::new(),
        },
        Ok(Ok(BeforeVerdict::Drop { reason })) => BeforeDecision::Drop { reason },
        Ok(Ok(BeforeVerdict::Annotate { fields })) => {
            if Event::validate_annotations(&fields).is_ok() {
                BeforeDecision::Keep {
                    reason: None,
                    annotations: fields,
                }
            } else {
                BeforeDecision::Keep {
                    reason: Some(HOOK_ANNOTATIONS_REASON.into()),
                    annotations: BTreeMap::new(),
                }
            }
        }
        Ok(Err(message)) => BeforeDecision::Keep {
            reason: Some(hook_error_reason(&message)),
            annotations: BTreeMap::new(),
        },
        Err(mpsc::RecvTimeoutError::Timeout) => BeforeDecision::Keep {
            reason: Some(HOOK_TIMEOUT_REASON.into()),
            annotations: BTreeMap::new(),
        },
        Err(mpsc::RecvTimeoutError::Disconnected) => BeforeDecision::Keep {
            reason: Some(HOOK_PANIC_REASON.into()),
            annotations: BTreeMap::new(),
        },
    }
}

// Shared fakes for the hook tests in this module and in poll.rs.
#[cfg(test)]
pub(crate) mod support {
    use std::collections::BTreeMap;
    use std::thread;
    use std::time::Duration;

    use super::{BeforeVerdict, EventBefore};
    use crate::{Event, EventId, EventKind, EventSubject, SourceName};

    /// Builds an event with the given ID and optional author.
    pub fn event(id: &str, author: Option<&str>) -> Event {
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
    pub struct BotFilter;

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
    pub struct FailingHook;

    impl EventBefore for FailingHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            Err("hook unavailable".into())
        }
    }

    /// Attaches the given fields to every event it keeps.
    pub struct AnnotatingHook(pub BTreeMap<String, String>);

    impl EventBefore for AnnotatingHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            Ok(BeforeVerdict::Annotate {
                fields: self.0.clone(),
            })
        }
    }

    /// Reports an already-named failure instead of a verdict.
    pub struct NamedErrorHook(pub &'static str);

    impl EventBefore for NamedErrorHook {
        fn verdict(
            &self,
            _event: &Event,
            _budget: Duration,
        ) -> Result<BeforeVerdict, String> {
            Err(self.0.into())
        }
    }

    /// Sleeps past any ordinary deadline before answering.
    pub struct BlockingHook;

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
    use std::collections::BTreeMap;

    use super::support::{
        AnnotatingHook, BlockingHook, BotFilter, FailingHook, NamedErrorHook,
        PanickingHook, event,
    };
    use super::*;

    fn in_flight() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn allow_all_is_a_passthrough_hook() {
        assert!(AllowAll.is_passthrough());

        let flag = in_flight();
        let decision = decide_before(
            Arc::new(AllowAll),
            &event("fired", None),
            Duration::from_nanos(1),
            &flag,
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: None,
                annotations: BTreeMap::new(),
            }
        );
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
        assert_eq!(
            kept,
            BeforeDecision::Keep {
                reason: None,
                annotations: BTreeMap::new(),
            }
        );
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
                annotations: BTreeMap::new(),
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
                annotations: BTreeMap::new(),
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
                annotations: BTreeMap::new(),
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
                reason: Some(HOOK_BUSY_REASON.into()),
                annotations: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn a_zero_budget_keeps_the_event_without_calling_the_hook() {
        let flag = in_flight();
        let decision = decide_before(
            Arc::new(FailingHook),
            &event("fired", None),
            Duration::ZERO,
            &flag,
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_TIMEOUT_REASON.into()),
                annotations: BTreeMap::new(),
            }
        );
        assert!(!flag.load(Ordering::Relaxed));
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

    #[test]
    fn an_annotating_hook_keeps_validated_fields() {
        let fields = BTreeMap::from([("agent".to_owned(), "deploy-bot".to_owned())]);
        let decision = decide_before(
            Arc::new(AnnotatingHook(fields.clone())),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: None,
                annotations: fields,
            }
        );
    }

    #[test]
    fn invalid_annotations_keep_the_event_without_fields() {
        let fields = BTreeMap::from([(String::new(), "value".to_owned())]);
        let decision = decide_before(
            Arc::new(AnnotatingHook(fields)),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_ANNOTATIONS_REASON.into()),
                annotations: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn a_named_hook_error_is_used_as_the_reason_verbatim() {
        let decision = decide_before(
            Arc::new(NamedErrorHook(HOOK_CONNECT_REASON)),
            &event("fired", None),
            EVENT_BEFORE_TIMEOUT,
            &in_flight(),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_CONNECT_REASON.into()),
                annotations: BTreeMap::new(),
            }
        );
    }
}
