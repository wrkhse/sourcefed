//! Manual parsing of the driver's two required options.

use sourcefed_sim::Seed;

/// The seed and the number of steps a simulation run uses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Args {
    pub seed: Seed,
    pub steps: u32,
}

impl Args {
    /// Parses `--seed <hex>` and `--steps <u32>` after the program name.
    ///
    /// # Errors
    /// Names the flag that is missing, unknown, repeated without a value or
    /// malformed, or the step count that is zero.
    pub fn parse(argv: &[String]) -> Result<Self, String> {
        let mut seed = None;
        let mut steps = None;
        let mut flags = argv.iter();

        while let Some(flag) = flags.next() {
            if flag != "--seed" && flag != "--steps" {
                return Err(format!("unknown argument {flag:?}"));
            }

            let Some(value) = flags.next() else {
                return Err(format!("missing value for {flag}"));
            };

            if flag == "--seed" {
                let parsed = value.parse::<Seed>();
                seed = Some(parsed.map_err(|e| format!("invalid --seed: {e}"))?);
            } else {
                steps = Some(parse_steps(value)?);
            }
        }

        let seed = seed.ok_or_else(|| String::from("missing --seed"))?;
        let steps = steps.ok_or_else(|| String::from("missing --steps"))?;

        Ok(Self { seed, steps })
    }
}

fn parse_steps(text: &str) -> Result<u32, String> {
    let steps = text
        .parse::<u32>()
        .map_err(|_| String::from("--steps must be a u32"))?;

    if steps == 0 {
        return Err(String::from("--steps must be greater than zero"));
    }

    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAD_DIGIT: &str = "invalid --seed: seed has a non-hex digit";
    const BAD_LENGTH: &str = "invalid --seed: seed must have 1 to 16 hex digits";

    fn argv(seed: &str, steps: &str) -> Vec<String> {
        ["--seed", seed, "--steps", steps]
            .iter()
            .map(|s| (*s).into())
            .collect()
    }

    fn error(args: &[String]) -> String {
        Args::parse(args).unwrap_err()
    }

    #[test]
    fn parses_a_hex_seed_and_a_step_count() {
        let expected = Args {
            seed: "00ff".parse().unwrap(),
            steps: 12,
        };

        assert_eq!(Args::parse(&argv("00ff", "12")), Ok(expected));
    }

    #[test]
    fn rejects_missing_unknown_and_malformed_flags() {
        let bogus = ["--bogus".into(), "1".into()];

        assert_eq!(error(&[]), "missing --seed");
        assert_eq!(error(&["--seed".into()]), "missing value for --seed");
        assert_eq!(error(&bogus), "unknown argument \"--bogus\"");
        assert_eq!(error(&["--steps".into(), "1".into()]), "missing --seed");
        assert_eq!(
            error(&["--seed".into(), "1".into(), "--steps".into()]),
            "missing value for --steps"
        );
        assert_eq!(error(&argv("xyz", "2")), BAD_DIGIT);
        assert_eq!(error(&argv("00000000000000000", "2")), BAD_LENGTH);
    }

    #[test]
    fn rejects_malformed_and_zero_steps() {
        assert_eq!(error(&argv("1", "two")), "--steps must be a u32");
        assert_eq!(error(&argv("1", "0")), "--steps must be greater than zero");
        assert_eq!(error(&argv("1", "4294967296")), "--steps must be a u32");
    }
}
