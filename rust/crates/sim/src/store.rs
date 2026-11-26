//! An in-memory `StateStore` with the file store's per-key limits.

use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use sourcefed_core::store::{MAX_PENDING_EVENTS, MAX_POSITIONS, MAX_SEEN_IDS};
use sourcefed_core::{
    Event, EventId, Position, PositionKey, StateStore, StoreError,
};

/// One key's remembered IDs and pending events.
#[derive(Clone, Debug, Default)]
struct KeyState {
    seen: VecDeque<EventId>,
    pending: VecDeque<Event>,
}

/// Shared fault switches and counters for a store held by an engine.
#[derive(Debug, Default)]
pub struct StoreControl {
    commit_fault: AtomicBool,
    ack_fault: AtomicBool,
    faults: AtomicUsize,
    commits: AtomicUsize,
}

impl StoreControl {
    /// Arms one commit fault; the next commit fails without changing state.
    pub fn fail_next_commit(&self) {
        self.commit_fault.store(true, Ordering::Relaxed);
    }

    /// Arms one ack fault; the next acknowledgement fails without changes.
    pub fn fail_next_ack(&self) {
        self.ack_fault.store(true, Ordering::Relaxed);
    }

    /// Returns how many scripted faults have fired.
    #[must_use]
    pub fn fault_count(&self) -> usize {
        self.faults.load(Ordering::Relaxed)
    }

    /// Returns how many commits succeeded.
    #[must_use]
    pub fn commits(&self) -> usize {
        self.commits.load(Ordering::Relaxed)
    }

    fn take_commit(&self) -> bool {
        self.take(&self.commit_fault)
    }

    fn take_ack(&self) -> bool {
        self.take(&self.ack_fault)
    }

    fn take(&self, flag: &AtomicBool) -> bool {
        let fired = flag.swap(false, Ordering::Relaxed);

        if fired {
            self.faults.fetch_add(1, Ordering::Relaxed);
        }

        fired
    }

    fn fault(action: &str) -> StoreError {
        StoreError::Write {
            path: PathBuf::from("memory"),
            source: io::Error::other(action),
        }
    }
}

/// An in-memory store with owned reads and scripted write faults.
#[derive(Debug)]
pub struct MemoryStore {
    positions: BTreeMap<PositionKey, Position>,
    states: BTreeMap<PositionKey, KeyState>,
    control: Arc<StoreControl>,
}

impl MemoryStore {
    /// Starts empty with a reusable handle for scripted faults.
    #[must_use]
    pub fn new() -> Self {
        Self {
            positions: BTreeMap::new(),
            states: BTreeMap::new(),
            control: Arc::new(StoreControl::default()),
        }
    }

    /// Returns the shared fault and commit control.
    #[must_use]
    pub fn control(&self) -> Arc<StoreControl> {
        self.control.clone()
    }

    /// Returns whether an ID is pending under any key.
    #[must_use]
    pub fn is_pending(&self, id: &EventId) -> bool {
        self.states
            .values()
            .any(|state| state.pending.iter().any(|event| event.id() == id))
    }

    fn position_of(&self, key: &PositionKey) -> Option<Position> {
        self.positions.get(key).cloned()
    }

    fn seen(&self, key: &PositionKey, id: &EventId) -> bool {
        self.states
            .get(key)
            .is_some_and(|state| state.seen.contains(id))
    }

    fn pending_of(&self, key: &PositionKey) -> Option<VecDeque<Event>> {
        self.states.get(key).map(|state| state.pending.clone())
    }

    // Applies a batch to a copy so a refused commit leaves no partial state.
    fn record(
        &self,
        key: &PositionKey,
        events: &[Event],
    ) -> Result<(KeyState, usize), StoreError> {
        let mut state = self.states.get(key).cloned().unwrap_or_default();
        let mut distinct = Vec::new();
        let mut repeats = Vec::new();
        let mut fresh = Vec::new();
        let pending = state.pending.len();
        let room = MAX_PENDING_EVENTS.saturating_sub(pending).min(MAX_SEEN_IDS);

        // Classify against the IDs known before the batch, so refreshing a
        // repeat can never evict an ID this batch adds.
        for event in events {
            let id = event.id();

            if distinct.contains(id) {
                continue;
            }

            distinct.push(id.clone());

            if state.seen.contains(id) {
                repeats.push(id.clone());
            } else {
                if fresh.len() == room {
                    return Err(StoreError::TooMany { limit: room });
                }

                fresh.push(event.clone());
            }
        }

        Self::refresh(&mut state, &repeats);
        Self::evict(&mut state, fresh.len())?;

        for event in fresh {
            state.seen.push_back(event.id().clone());
            state.pending.push_back(event);
        }

        let count = distinct.len().saturating_sub(repeats.len());

        Ok((state, count))
    }

    // Moving a repeat never grows the seen queue.
    fn refresh(state: &mut KeyState, repeats: &[EventId]) {
        for id in repeats {
            if let Some(index) = state.seen.iter().position(|known| known == id) {
                state.seen.remove(index);
            }

            state.seen.push_back(id.clone());
        }
    }

    // Evicts only IDs with no pending event, so an ack can find them later.
    fn evict(state: &mut KeyState, extra: usize) -> Result<(), StoreError> {
        let needed = state
            .seen
            .len()
            .saturating_add(extra)
            .saturating_sub(MAX_SEEN_IDS);

        if needed == 0 {
            return Ok(());
        }

        let pending: Vec<&EventId> = state.pending.iter().map(Event::id).collect();

        for _ in 0..needed {
            let index = state
                .seen
                .iter()
                .position(|id| !pending.contains(&id))
                .ok_or(StoreError::TooMany {
                    limit: MAX_SEEN_IDS,
                })?;

            state.seen.remove(index);
        }

        Ok(())
    }

    fn commit_state(
        &mut self,
        key: PositionKey,
        position: Position,
        state: KeyState,
    ) {
        self.states.insert(key.clone(), state);
        self.positions.insert(key, position);
        self.control.commits.fetch_add(1, Ordering::Relaxed);
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl StateStore for MemoryStore {
    fn position(&self, key: &PositionKey) -> Option<Position> {
        self.position_of(key)
    }

    fn is_seen(&self, key: &PositionKey, id: &EventId) -> bool {
        self.seen(key, id)
    }

    fn pending(&self, key: &PositionKey) -> Option<VecDeque<Event>> {
        self.pending_of(key)
    }

    fn ack_pending(
        &mut self,
        key: &PositionKey,
        ids: &[EventId],
    ) -> Result<usize, StoreError> {
        if self.control.take_ack() {
            return Err(StoreControl::fault("simulated ack fault"));
        }

        if ids.is_empty() {
            return Ok(0);
        }

        let Some(mut state) = self.states.get(key).cloned() else {
            return Ok(0);
        };
        let before = state.pending.len();

        state.pending.retain(|event| !ids.contains(event.id()));
        let removed = before.saturating_sub(state.pending.len());

        if removed == 0 {
            return Ok(0);
        }

        self.states.insert(key.clone(), state);

        Ok(removed)
    }

    fn commit(
        &mut self,
        key: PositionKey,
        position: Position,
        events: &[Event],
    ) -> Result<usize, StoreError> {
        if self.control.take_commit() {
            return Err(StoreControl::fault("simulated commit fault"));
        }

        if self.positions.len() == MAX_POSITIONS
            && !self.positions.contains_key(&key)
        {
            return Err(StoreError::TooMany {
                limit: MAX_POSITIONS,
            });
        }

        let (state, count) = self.record(&key, events)?;

        self.commit_state(key, position, state);

        Ok(count)
    }
}
