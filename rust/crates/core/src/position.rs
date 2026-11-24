use serde::{Deserialize, Serialize};

use crate::{MAX_POSITION_LEN, ModelError, validate_text};

/// Where a source left off, saved after each poll so the next poll, even after
/// a restart, resumes there.
///
/// Only the source that writes the text interprets it. It holds 1 to
/// [`MAX_POSITION_LEN`] bytes with no control characters, and deserializing
/// applies the same checks.
#[derive(
    Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(try_from = "String", into = "String")]
pub struct Position(String);

impl Position {
    /// Wraps a source's position text after checking it.
    ///
    /// # Errors
    ///
    /// Returns an error for empty, oversized, or control-containing positions.
    pub fn new(value: String) -> Result<Self, ModelError> {
        validate_text(&value, "position", MAX_POSITION_LEN)?;

        Ok(Self(value))
    }

    /// Returns the position text.
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
    use proptest::{prop_assert_eq, proptest};
    use serde_json::error::Category;

    use super::*;
    use crate::bounded_text;

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
        for (json, expected) in [
            (r#""""#.to_owned(), "position is empty"),
            (
                r#""\n""#.to_owned(),
                "position contains a control character",
            ),
            (
                serde_json::to_string(&"x".repeat(MAX_POSITION_LEN + 1)).unwrap(),
                "position exceeds 4096 bytes",
            ),
        ] {
            let error = serde_json::from_str::<Position>(&json).unwrap_err();

            assert_eq!(error.classify(), Category::Data);
            assert_eq!(error.to_string(), expected);
        }
    }

    proptest! {
        #[test]
        fn accepted_positions_preserve_the_input(input in bounded_text()) {
            if let Ok(value) = Position::new(input.clone()) {
                let len = value.as_str().len();

                prop_assert_eq!(value.as_str().as_bytes(), input.as_bytes());
                prop_assert_eq!(len, len.min(MAX_POSITION_LEN));
                prop_assert_eq!(String::from(value), input);
            }
        }
    }
}
