pub mod event;
pub mod monitor;
pub mod position;
pub mod source;

pub use event::{Event, EventId, EventKind, EventSubject};
pub use monitor::{MonitorConfig, MonitorId, MonitorStatus, PollInterval};
pub use position::Position;
pub use source::{PollError, PollOutcome, PollRequest, Source, SourceName};

pub const MAX_ID_LEN: usize = 256;
pub const MAX_POSITION_LEN: usize = 4096;
pub const MAX_SUMMARY_LEN: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ModelError {
    #[error("{field} is empty")]
    Empty { field: &'static str },
    #[error("{field} exceeds {limit} bytes")]
    TooLong { field: &'static str, limit: usize },
    #[error("{field} {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

pub(crate) fn validate_text(
    value: &str,
    field: &'static str,
    limit: usize,
) -> Result<(), ModelError> {
    if value.is_empty() {
        return Err(ModelError::Empty { field });
    }
    if value.len() > limit {
        return Err(ModelError::TooLong { field, limit });
    }
    if value.chars().any(char::is_control) {
        return Err(ModelError::Invalid {
            field,
            reason: "contains a control character",
        });
    }

    Ok(())
}
