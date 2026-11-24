use serde::{Deserialize, Serialize};

use crate::{MAX_POSITION_LEN, ModelError, validate_text};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Position(String);

impl Position {
    /// # Errors
    ///
    /// Returns an error for empty, oversized, or control-containing positions.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "position", MAX_POSITION_LEN)?;

        Ok(Self(value))
    }

    #[must_use]
    pub const fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl TryFrom<String> for Position {
    type Error = ModelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<Position> for String {
    fn from(position: Position) -> Self {
        position.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_one_byte_and_the_maximum() {
        for value in ["x".to_owned(), "🦀".repeat(MAX_POSITION_LEN / 4)] {
            assert_eq!(Position::new(value.clone()).unwrap().as_str(), value);
        }
    }

    #[test]
    fn rejects_empty_oversized_and_control_containing_positions() {
        assert_eq!(
            Position::new(String::new()),
            Err(ModelError::Empty { field: "position" })
        );
        assert_eq!(
            Position::new(format!("{}x", "🦀".repeat(MAX_POSITION_LEN / 4))),
            Err(ModelError::TooLong {
                field: "position",
                limit: MAX_POSITION_LEN,
            })
        );
        assert_eq!(
            Position::new("cursor\u{85}".into()),
            Err(ModelError::Invalid {
                field: "position",
                reason: "contains a control character",
            })
        );
    }

    #[test]
    fn json_positions_are_validated() {
        for value in [String::new(), "\n".into(), "x".repeat(MAX_POSITION_LEN + 1)] {
            let json = serde_json::to_string(&value).unwrap();

            assert_eq!(serde_json::from_str::<Position>(&json).ok(), None);
        }
    }
}
