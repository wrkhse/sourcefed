//! Deterministic choices for a simulation run.
//!
//! Every simulated choice comes from one seed, so a seed and a step count
//! describe a whole run without consulting a clock or the operating system.

use std::fmt;

const GOLDEN_RATIO: u64 = 0x9E37_79B9_7F4A_7C15;

/// A deterministic source of choices, parsed from 16 hexadecimal digits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Seed(u64);

impl Seed {
    /// Parses exactly 16 hexadecimal digits.
    ///
    /// # Errors
    /// Returns a short reason when `text` is not 16 hexadecimal digits.
    pub fn from_hex(text: &str) -> Result<Self, String> {
        if text.len() != 16 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("seed must be 16 hexadecimal digits".to_owned());
        }

        let value =
            u64::from_str_radix(text, 16).map_err(|error| error.to_string())?;

        Ok(Self(value))
    }

    /// Returns the next 64 bits from the `SplitMix64` stream.
    #[must_use]
    pub const fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(GOLDEN_RATIO);

        let mut value = self.0;
        let mixed = value ^ value.wrapping_shr(30);
        value = mixed.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        let mixed = value ^ value.wrapping_shr(27);
        value = mixed.wrapping_mul(0x94D0_49BB_1331_11EB);

        value ^ value.wrapping_shr(31)
    }

    /// Returns a value below `bound`; a zero bound yields zero.
    #[must_use]
    pub fn below(&mut self, bound: u64) -> u64 {
        let divisor = bound.max(1);

        self.next_u64().checked_rem(divisor).unwrap_or(0)
    }

    /// Picks an index from `len` entries, or `None` when `len` is zero.
    #[must_use]
    pub fn pick_index(&mut self, len: usize) -> Option<usize> {
        if len == 0 {
            return None;
        }

        let bound = u64::try_from(len).ok()?;

        usize::try_from(self.below(bound)).ok()
    }
}

impl fmt::Display for Seed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_returns_the_exact_drawn_value() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();

        assert_eq!(seed.below(10), 5);
    }

    #[test]
    fn pick_index_handles_empty_single_and_large_collections() {
        let mut seed = Seed::from_hex("0000000000000001").unwrap();

        assert_eq!(seed.pick_index(0), None);
        assert_eq!(seed.pick_index(6), Some(5));
        assert_eq!(seed.pick_index(1), Some(0));
    }
}
