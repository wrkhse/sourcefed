use std::sync::Arc;
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

/// What to do with one event before it is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeforeVerdict {
    /// Commit the event.
    Keep,
    /// Leave the event out of the commit; reason says why.
    Drop { reason: String },
}

/// The decision applied to one event before the poll outcome is committed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeforeDecision {
    /// Commit the event. reason names a hook failure that kept it, if any.
    Keep { reason: Option<String> },
    /// Leave the event out of the commit; reason says why.
    Drop { reason: String },
}

/// Decides whether an event is committed or left out.
///
/// Hooks are shared across threads, so each one is Send and Sync.
pub trait EventBefore: Send + Sync {
    /// Returns the verdict for event.
    ///
    /// # Errors
    /// Returns a message saying why no verdict is available.
    fn verdict(&self, event: &Event) -> Result<BeforeVerdict, String>;
}

/// An EventBefore that keeps every event.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl EventBefore for AllowAll {
    fn verdict(&self, _event: &Event) -> Result<BeforeVerdict, String> {
        Ok(BeforeVerdict::Keep)
    }
}

/// Asks a hook for one verdict within a deadline and applies the policy.
///
/// The hook runs on its own thread, so a hook that never answers yields a
/// timeout decision by the deadline and the caller never waits longer. An
/// error or a timeout keeps the event with a named reason for logging.
pub fn decide_before(
    before: Arc<dyn EventBefore>,
    event: &Event,
    timeout: Duration,
) -> BeforeDecision {
    let event = event.clone();
    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || {
        let _ = sender.send(before.verdict(&event));
    });

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
            reason: Some(HOOK_ERROR_REASON.into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EventId, EventKind, EventSubject, SourceName};

    fn event(author: Option<&str>) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "subject".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();
        let event = Event::new(
            EventId::new("fired".into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            at,
        )
        .unwrap();

        event.with_author(author.map(str::to_owned))
    }

    struct BotFilter;

    impl EventBefore for BotFilter {
        fn verdict(&self, event: &Event) -> Result<BeforeVerdict, String> {
            if event.author() == Some("bot") {
                Ok(BeforeVerdict::Drop {
                    reason: "bot author".into(),
                })
            } else {
                Ok(BeforeVerdict::Keep)
            }
        }
    }

    struct FailingHook;

    impl EventBefore for FailingHook {
        fn verdict(&self, _event: &Event) -> Result<BeforeVerdict, String> {
            Err("hook unavailable".into())
        }
    }

    struct BlockingHook;

    impl EventBefore for BlockingHook {
        fn verdict(&self, _event: &Event) -> Result<BeforeVerdict, String> {
            thread::sleep(Duration::from_millis(50));

            Ok(BeforeVerdict::Keep)
        }
    }

    #[test]
    fn allow_all_keeps_every_event() {
        let decision = decide_before(
            Arc::new(AllowAll),
            &event(Some("bot")),
            EVENT_BEFORE_TIMEOUT,
        );

        assert_eq!(decision, BeforeDecision::Keep { reason: None });
    }

    #[test]
    fn a_hook_can_drop_a_bot_author() {
        let dropped = decide_before(
            Arc::new(BotFilter),
            &event(Some("bot")),
            EVENT_BEFORE_TIMEOUT,
        );
        let kept = decide_before(
            Arc::new(BotFilter),
            &event(Some("alice")),
            EVENT_BEFORE_TIMEOUT,
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
        let decision =
            decide_before(Arc::new(FailingHook), &event(None), EVENT_BEFORE_TIMEOUT);

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
            &event(None),
            Duration::from_millis(2),
        );

        assert_eq!(
            decision,
            BeforeDecision::Keep {
                reason: Some(HOOK_TIMEOUT_REASON.into()),
            }
        );
    }
}
