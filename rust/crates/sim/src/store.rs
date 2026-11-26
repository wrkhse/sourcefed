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

/// The message on a scripted commit write fault.
pub const COMMIT_FAULT: &str = "simulated commit fault";
/// The message on a scripted acknowledgement write fault.
pub const ACK_FAULT: &str = "simulated ack fault";

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
            return Err(StoreControl::fault(ACK_FAULT));
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
            return Err(StoreControl::fault(COMMIT_FAULT));
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
#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use sourcefed_core::store::{MAX_POSITIONS, MAX_SEEN_IDS};
    use sourcefed_core::{
        EventId, EventKind, EventSubject, MonitorId, Position, SourceName,
    };

    use super::*;

    fn event(id: &str) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "subject".into()).unwrap();

        Event::new(
            EventId::new(id.into()).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            Timestamp::UNIX_EPOCH,
        )
        .unwrap()
    }

    fn key(name: &str) -> PositionKey {
        PositionKey {
            monitor: MonitorId::new(name.into()).unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        }
    }

    fn position(text: &str) -> Position {
        Position::new(text.into()).unwrap()
    }

    #[test]
    fn commit_saves_position_seen_ids_and_pending_events() {
        let mut store = MemoryStore::new();
        let pending = event("e1");
        let key = key("sim");

        assert_eq!(
            store
                .commit(key.clone(), position("1"), std::slice::from_ref(&pending))
                .unwrap(),
            1
        );
        assert_eq!(store.position(&key), Some(position("1")));
        assert!(store.is_seen(&key, pending.id()));
        assert!(store.is_pending(pending.id()));
        assert_eq!(store.control().commits(), 1);

        let saved = store.pending(&key).unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id(), pending.id());
    }

    #[test]
    fn a_commit_fault_leaves_state_unchanged() {
        let mut store = MemoryStore::new();
        let control = store.control();
        control.fail_next_commit();

        let pending = event("e1");
        let result =
            store.commit(key("sim"), position("1"), std::slice::from_ref(&pending));

        assert!(matches!(result, Err(StoreError::Write { .. })));
        assert_eq!(control.fault_count(), 1);
        assert_eq!(control.commits(), 0);
        assert_eq!(store.position(&key("sim")), None);
        assert!(!store.is_pending(pending.id()));
    }

    #[test]
    fn an_ack_fault_leaves_pending_unchanged() {
        let mut store = MemoryStore::new();
        let pending = event("e1");
        let key = key("sim");
        let control = store.control();

        assert_eq!(
            store
                .commit(key.clone(), position("1"), std::slice::from_ref(&pending))
                .unwrap(),
            1
        );

        control.fail_next_ack();
        let result = store.ack_pending(&key, std::slice::from_ref(pending.id()));

        assert!(matches!(result, Err(StoreError::Write { .. })));
        assert_eq!(control.fault_count(), 1);
        assert_eq!(store.pending(&key).unwrap().len(), 1);
        assert!(store.is_pending(pending.id()));
    }

    #[test]
    fn ack_removes_only_the_named_event() {
        let mut store = MemoryStore::new();
        let first = event("e1");
        let second = event("e2");
        let key = key("sim");
        let batch = [first.clone(), second.clone()];

        assert_eq!(store.commit(key.clone(), position("1"), &batch).unwrap(), 2);
        assert_eq!(
            store
                .ack_pending(&key, std::slice::from_ref(first.id()))
                .unwrap(),
            1
        );
        assert!(!store.is_pending(first.id()));
        assert!(store.is_pending(second.id()));
        assert!(store.is_seen(&key, first.id()));
        assert_eq!(store.pending(&key).unwrap().len(), 1);
    }

    #[test]
    fn too_many_positions_are_refused() {
        let mut store = MemoryStore::new();

        for index in 0..MAX_POSITIONS {
            let name = format!("m{index}");

            assert_eq!(store.commit(key(&name), position("1"), &[]).unwrap(), 0);
        }

        let result = store.commit(key("overflow"), position("1"), &[]);

        assert!(matches!(result, Err(StoreError::TooMany { limit: 256 })));
        assert_eq!(store.control().commits(), 256);
    }

    #[test]
    fn too_many_fresh_events_are_refused() {
        let mut store = MemoryStore::new();
        let batch: Vec<Event> = (0..1001)
            .map(|index| event(&format!("e{index:04}")))
            .collect();
        let result = store.commit(key("sim"), position("1"), &batch);

        assert!(matches!(result, Err(StoreError::TooMany { limit: 1000 })));
        assert_eq!(store.control().commits(), 0);
        assert!(!store.is_pending(event("e0000").id()));
    }

    fn trait_seen<S: StateStore>(
        store: &S,
        key: &PositionKey,
        id: &EventId,
    ) -> bool {
        store.is_seen(key, id)
    }

    #[test]
    fn fault_count_starts_at_zero_and_counts_each_fault() {
        let mut store = MemoryStore::new();
        let control = store.control();

        assert_eq!(control.fault_count(), 0);

        control.fail_next_commit();
        let first = store.commit(key("sim"), position("1"), &[]);

        assert!(matches!(first, Err(StoreError::Write { .. })));
        assert_eq!(control.fault_count(), 1);

        control.fail_next_ack();
        let second = store.ack_pending(&key("sim"), &[event("e1").id().clone()]);

        assert!(matches!(second, Err(StoreError::Write { .. })));
        assert_eq!(control.fault_count(), 2);
    }

    #[test]
    fn the_state_store_trait_reports_unknown_ids_as_unseen() {
        let mut store = MemoryStore::new();
        let key = key("sim");
        let known = event("e1");
        let unknown = event("e2");

        assert_eq!(
            store
                .commit(key.clone(), position("1"), std::slice::from_ref(&known))
                .unwrap(),
            1
        );

        assert!(trait_seen(&store, &key, known.id()));
        assert!(!trait_seen(&store, &key, unknown.id()));
    }

    #[test]
    fn refresh_moves_repeated_ids_to_the_newest_end() {
        let ids: Vec<EventId> = ["e1", "e2", "e3"]
            .iter()
            .map(|id| EventId::new((*id).into()).unwrap())
            .collect();
        let mut state = KeyState {
            seen: ids.iter().cloned().collect(),
            pending: VecDeque::new(),
        };

        MemoryStore::refresh(&mut state, std::slice::from_ref(&ids[0]));

        let expected: VecDeque<EventId> =
            [ids[1].clone(), ids[2].clone(), ids[0].clone()]
                .into_iter()
                .collect();

        assert_eq!(state.seen, expected);
    }

    #[test]
    fn evict_removes_the_oldest_id_that_is_not_pending() {
        let ids: Vec<EventId> = (0..MAX_SEEN_IDS)
            .map(|index| EventId::new(format!("e{index:04}")).unwrap())
            .collect();
        let mut state = KeyState {
            seen: ids.iter().cloned().collect(),
            pending: VecDeque::from(vec![event("e0000")]),
        };

        MemoryStore::evict(&mut state, 1).unwrap();

        let mut expected: VecDeque<EventId> = VecDeque::new();
        expected.push_back(ids[0].clone());
        expected.extend(ids.iter().skip(2).cloned());

        assert_eq!(state.seen, expected);
    }

    #[test]
    fn evict_fails_when_every_seen_id_is_pending() {
        let id = EventId::new("e1".into()).unwrap();
        let mut state = KeyState {
            seen: VecDeque::from(vec![id]),
            pending: VecDeque::from(vec![event("e1")]),
        };

        assert!(matches!(
            MemoryStore::evict(&mut state, MAX_SEEN_IDS),
            Err(StoreError::TooMany {
                limit: MAX_SEEN_IDS
            })
        ));
    }
}
