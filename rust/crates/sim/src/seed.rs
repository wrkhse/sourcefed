//! Deterministic draws from a fixed seed.
//!
//! Every choice a simulation makes comes from `Seed`; no wall clock or
//! operating-system randomness is consulted.

use std::fmt;
use std::str::FromStr;

const GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;
const MIX_1: u64 = 0xBF58_476D_1CE4_E5B9;
const MIX_2: u64 = 0x94D0_49BB_1331_11EB;
const SEED_HEX_LEN: usize = 16;

/// A 64-bit seed whose draws are the only source of simulation choices.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Seed(u64);

/// Why a string cannot be parsed as a `Seed`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeedError {
    /// The text does not have exactly 16 bytes.
    Length,
    /// One byte is not a hexadecimal digit.
    Digit,
}

impl fmt::Display for SeedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length => formatter.write_str("seed must have 16 hex digits"),
            Self::Digit => formatter.write_str("seed has a non-hex digit"),
        }
    }
}

impl std::error::Error for SeedError {}

impl Seed {
    /// Wraps a raw state; draws are unchanged by how the state was built.
    #[must_use]
    pub const fn from_u64(value: u64) -> Self {
        Self(value)
    }

    /// Returns the raw state.
    #[must_use]
    pub const fn as_u64(self) -> u64 {
        self.0
    }

    /// Draws the next value with splitmix64 and advances the state.
    pub const fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(GAMMA);

        let mut value = self.0;
        value = (value ^ value.wrapping_shr(30)).wrapping_mul(MIX_1);
        value = (value ^ value.wrapping_shr(27)).wrapping_mul(MIX_2);

        value ^ value.wrapping_shr(31)
    }

    /// Draws a value below `bound`, or zero when the bound is zero.
    pub fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            return 0;
        }

        self.next_u64().checked_rem(bound).unwrap_or(0)
    }

    /// Draws an index below `len`, or zero when the length is zero.
    pub fn pick_index(&mut self, len: usize) -> usize {
        if len == 0 {
            return 0;
        }

        let bound = u64::try_from(len).unwrap_or(u64::MAX);
        let draw = self.below(bound);

        usize::try_from(draw).unwrap_or_default()
    }
}

impl FromStr for Seed {
    type Err = SeedError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.len() != SEED_HEX_LEN {
            return Err(SeedError::Length);
        }

        let mut value = 0_u64;

        for byte in text.bytes() {
            let digit = match byte {
                b'0'..=b'9' => byte.wrapping_sub(b'0'),
                b'a'..=b'f' => byte.wrapping_sub(b'a').wrapping_add(10),
                b'A'..=b'F' => byte.wrapping_sub(b'A').wrapping_add(10),
                _ => return Err(SeedError::Digit),
            };

            value = value.wrapping_shl(4).wrapping_add(u64::from(digit));
        }

        Ok(Self(value))
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
    fn splitmix64_draws_match_known_values() {
        let start = Seed::from_u64(1);
        let mut seed = start;
        let expected = [
            0x910A_2DEC_8902_5CC1_u64,
            0xBEEB_8DA1_658E_EC67,
            0xF893_A2EE_FB32_555E,
            0x71C1_8690_EE42_C90B,
            0x71BB_54D8_D101_B5B9,
            0xC34D_0BFF_9015_0280,
        ];

        for value in expected {
            assert_eq!(seed.next_u64(), value);
        }
        assert_eq!(
            seed.as_u64(),
            start.as_u64().wrapping_add(6_u64.wrapping_mul(GAMMA))
        );
    }

    #[test]
    fn below_uses_one_draw_and_handles_a_zero_bound() {
        let mut seed = Seed::from_u64(1);

        assert_eq!(seed.below(10), 5);
        assert_eq!(seed.below(1000), 519);
        assert_eq!(seed.below(0), 0);
        assert_eq!(
            seed.as_u64(),
            Seed::from_u64(0xBEEB_8DA1_658E_EC67).as_u64()
        );
    }

    #[test]
    fn pick_index_draws_within_the_requested_length() {
        let mut seed = Seed::from_u64(42);
        let mut other = Seed::from_u64(42);

        assert_eq!(seed.pick_index(7), 5);
        assert_eq!(other.next_u64().checked_rem(7), Some(5));
        assert_eq!(seed.pick_index(0), 0);
    }

    #[test]
    fn parsing_requires_exactly_16_hex_digits() {
        assert_eq!("0000000000000001".parse::<Seed>(), Ok(Seed::from_u64(1)));
        assert_eq!(
            "00FFff00000000aA".parse::<Seed>(),
            Ok(Seed::from_u64(0x00FF_FF00_0000_00AA))
        );
        assert_eq!("000000000000001".parse::<Seed>(), Err(SeedError::Length));
        assert_eq!("00000000000000000".parse::<Seed>(), Err(SeedError::Length));
        assert_eq!("000000000000000g".parse::<Seed>(), Err(SeedError::Digit));
    }

    #[test]
    fn display_pads_to_16_lowercase_hex_digits() {
        assert_eq!(Seed::from_u64(1).to_string(), "0000000000000001");
        assert_eq!(Seed::from_u64(u64::MAX).to_string(), "ffffffffffffffff");
        assert_eq!(
            "00000000000000Aa".parse::<Seed>().unwrap().to_string(),
            "00000000000000aa"
        );
        assert_eq!(
            SeedError::Length.to_string(),
            "seed must have 16 hex digits"
        );
        assert_eq!(SeedError::Digit.to_string(), "seed has a non-hex digit");
    }
}
