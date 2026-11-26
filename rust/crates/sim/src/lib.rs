//! Deterministic simulation primitives for sourcefed.
//!
//! A `Seed` supplies every choice, a `SimClock` advances virtual time
//! without sleeping the thread, a `MemoryStore` applies writes atomically,
//! and `replay` records the steps into a hashable `Trace`. Nothing in this
//! crate starts a process, reads the wall clock or uses OS randomness.

/// A virtual clock with scripted readings and non-blocking sleeps.
pub mod clock;
/// Deterministic draws from a fixed seed.
pub mod seed;
/// An in-memory store with the file store's limits and atomic writes.
pub mod store;
/// Deterministic replay of seed-driven steps.
pub mod trace;

pub use clock::{ClockFault, SimClock};
pub use seed::{Seed, SeedError};
pub use store::{MemoryStore, StoreControl};
pub use trace::{Step, Trace, replay};
