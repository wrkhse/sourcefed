//! Checks at-least-once delivery against one simulation trace.

use std::fmt;

/// A guarantee a simulation run must uphold.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Guarantee {
    /// Every emitted event is delivered or acknowledged.
    AtLeastOnceDelivery,
    /// An acknowledged event is never redelivered after the halt.
    NoAckLostBeforeHalt,
}

impl fmt::Display for Guarantee {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AtLeastOnceDelivery => formatter.write_str("AtLeastOnceDelivery"),
            Self::NoAckLostBeforeHalt => formatter.write_str("NoAckLostBeforeHalt"),
        }
    }
}

/// One broken guarantee and the observation that broke it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Violation {
    pub guarantee: Guarantee,
    pub reason: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.guarantee, self.reason)
    }
}

/// What one run did, in the terms delivery is stated in.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Trace {
    pub emitted: Vec<String>,
    pub printed: Vec<String>,
    pub acked: Vec<String>,
    pub replayed: Vec<String>,
}

/// Checks delivery against one trace.
#[derive(Clone, Copy, Debug, Default)]
pub struct Checker;

impl Checker {
    /// Returns one violation for each emitted ID never printed or acked.
    #[must_use]
    pub fn check(trace: &Trace) -> Vec<Violation> {
        let mut violations = check_delivery(trace);
        violations.extend(check_ack_loss(trace));
        violations
    }
}

fn check_delivery(trace: &Trace) -> Vec<Violation> {
    trace
        .emitted
        .iter()
        .filter(|id| !trace.printed.contains(id) && !trace.acked.contains(id))
        .map(|id| Violation {
            guarantee: Guarantee::AtLeastOnceDelivery,
            reason: format!("emitted event {id} was neither printed nor acked"),
        })
        .collect()
}

fn check_ack_loss(trace: &Trace) -> Vec<Violation> {
    trace
        .acked
        .iter()
        .filter(|id| trace.replayed.contains(id))
        .map(|id| Violation {
            guarantee: Guarantee::NoAckLostBeforeHalt,
            reason: format!("acked event {id} was redelivered after halt"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED_DELIVERY: u64 = 0x0A11_0000_0000_0001;
    const SEED_ACK_LOSS: u64 = 0xACCF_0000_0000_0001;

    fn base_trace(seed: u64) -> Trace {
        let id = format!("event-{seed:016x}");

        Trace {
            emitted: vec![id.clone()],
            printed: vec![id.clone()],
            acked: vec![id],
            replayed: Vec::new(),
        }
    }

    fn violation(guarantee: Guarantee, reason: String) -> Vec<Violation> {
        vec![Violation { guarantee, reason }]
    }

    fn assert_clean(trace: &Trace) {
        assert_eq!(Checker::check(trace), Vec::<Violation>::new());
    }

    // Bug seed 0a11000000000001: an emitted ID is never printed or acked.
    #[test]
    fn seed_0a11000000000001_lost_event_is_reported() {
        let mut trace = base_trace(SEED_DELIVERY);
        let missing = format!("event-{SEED_DELIVERY:016x}-lost");
        trace.emitted.push(missing.clone());

        assert_eq!(
            Checker::check(&trace),
            violation(
                Guarantee::AtLeastOnceDelivery,
                format!("emitted event {missing} was neither printed nor acked")
            )
        );
    }

    // Bug seed accf000000000001: an acked ID reappears after the ack.
    #[test]
    fn seed_accf000000000001_replayed_ack_is_reported() {
        let id = format!("event-{SEED_ACK_LOSS:016x}");
        let trace = Trace {
            acked: vec![id.clone()],
            replayed: vec![id.clone()],
            ..Default::default()
        };

        assert_eq!(
            Checker::check(&trace),
            violation(
                Guarantee::NoAckLostBeforeHalt,
                format!("acked event {id} was redelivered after halt")
            )
        );
    }

    #[test]
    fn an_acked_id_absent_from_replayed_produces_no_violation() {
        let trace = Trace {
            acked: vec![String::from("event-acked")],
            replayed: vec![String::from("event-fresh")],
            ..Default::default()
        };

        assert_clean(&trace);
    }

    #[test]
    fn clean_traces_produce_no_violations() {
        // An emitted event counts as delivered when it is acked, not printed.
        let mut acked_only = base_trace(SEED_DELIVERY);
        acked_only.printed.clear();

        assert_clean(&base_trace(SEED_DELIVERY));
        assert_clean(&acked_only);
    }

    #[test]
    fn a_guarantee_displays_its_name_exactly() {
        assert_eq!(
            Guarantee::AtLeastOnceDelivery.to_string(),
            "AtLeastOnceDelivery"
        );
        assert_eq!(
            Guarantee::NoAckLostBeforeHalt.to_string(),
            "NoAckLostBeforeHalt"
        );
    }

    #[test]
    fn a_violation_displays_its_guarantee_and_reason_exactly() {
        let violation = Violation {
            guarantee: Guarantee::AtLeastOnceDelivery,
            reason: String::from("missing event-7"),
        };

        assert_eq!(
            violation.to_string(),
            "AtLeastOnceDelivery: missing event-7"
        );
    }
}
