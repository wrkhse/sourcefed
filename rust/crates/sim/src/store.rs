//! An in-memory store with the file store's limits and atomic writes.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io;
use std::path::PathBuf;

use sourcefed_core::store::{MAX_PENDING_EVENTS, MAX_POSITIONS, MAX_SEEN_IDS};
use sourcefed_core::{
    Event, EventId, Position, PositionKey, StateStore, StoreError,
};

/// Which scripted write fails on the next matching operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreControl {
    /// Fail the next commit.
    CommitFault,
    /// Fail the next acknowledgement that removes events.
    AckFault,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct State {
    positions: BTreeMap<PositionKey, Position>,
    seen: BTreeMap<PositionKey, VecDeque<EventId>>,
    pending: BTreeMap<PositionKey, VecDeque<Event>>,
}

/// A store that keeps all state in memory and applies writes atomically.
///
/// Each key has the file store's own limits: `MAX_POSITIONS` positions in
/// total, `MAX_SEEN_IDS` remembered IDs and `MAX_PENDING_EVENTS` pending
/// events per key. A commit saves the position, refreshed IDs and fresh events
/// together, or leaves the state unchanged. Acknowledging removes pending
/// events without forgetting their IDs. Eviction never removes the ID of an
/// event that is still pending.
#[derive(Debug, Default)]
pub struct MemoryStore {
    state: State,
    commit_faults: u64,
    ack_faults: u64,
}

impl MemoryStore {
    /// Creates an empty store with no scripted faults.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues one write fault for the next matching operation.
    pub const fn script(&mut self, control: StoreControl) {
        match control {
            StoreControl::CommitFault => {
                self.commit_faults = self.commit_faults.saturating_add(1);
            }
            StoreControl::AckFault => {
                self.ack_faults = self.ack_faults.saturating_add(1);
            }
        }
    }

    // Each fault is consumed by the operation it names, never by another one.
    const fn take_fault(&mut self, control: StoreControl) -> bool {
        let count = match control {
            StoreControl::CommitFault => &mut self.commit_faults,
            StoreControl::AckFault => &mut self.ack_faults,
        };

        if *count == 0 {
            return false;
        }

        *count = count.saturating_sub(1);

        true
    }

    fn write_fault(control: StoreControl) -> StoreError {
        let reason = match control {
            StoreControl::CommitFault => "scripted commit fault",
            StoreControl::AckFault => "scripted ack fault",
        };

        StoreError::Write {
            path: PathBuf::from("sim"),
            source: io::Error::other(reason),
        }
    }
}

impl StateStore for MemoryStore {
    fn position(&self, key: &PositionKey) -> Option<Position> {
        self.state.positions.get(key).cloned()
    }

    fn is_seen(&self, key: &PositionKey, id: &EventId) -> bool {
        self.state.seen.get(key).is_some_and(|ids| ids.contains(id))
    }

    fn pending(&self, key: &PositionKey) -> Option<VecDeque<Event>> {
        self.state.pending.get(key).cloned()
    }

    fn ack_pending(
        &mut self,
        key: &PositionKey,
        ids: &[EventId],
    ) -> Result<usize, StoreError> {
        let Some(queue) = self.state.pending.get(key) else {
            return Ok(0);
        };
        let matched = queue
            .iter()
            .filter(|event| ids.contains(event.id()))
            .count();
        let removed = matched;

        if removed == 0 {
            return Ok(0);
        }

        if self.take_fault(StoreControl::AckFault) {
            return Err(Self::write_fault(StoreControl::AckFault));
        }

        let mut next = self.state.clone();
        let Some(queue) = next.pending.get_mut(key) else {
            return Ok(0);
        };
        queue.retain(|event| !ids.contains(event.id()));
        self.state = next;

        Ok(removed)
    }

    fn commit(
        &mut self,
        key: PositionKey,
        position: Position,
        events: &[Event],
    ) -> Result<usize, StoreError> {
        if self.take_fault(StoreControl::CommitFault) {
            return Err(Self::write_fault(StoreControl::CommitFault));
        }

        if self.state.positions.len() == MAX_POSITIONS
            && !self.state.positions.contains_key(&key)
        {
            return Err(StoreError::TooMany {
                limit: MAX_POSITIONS,
            });
        }

        let mut next = self.state.clone();
        let count = record(&mut next, &key, events)?;
        next.positions.insert(key, position);
        self.state = next;

        Ok(count)
    }
}

// Applies one batch to a private copy of the state so a refused commit changes
// nothing. Repeated IDs move to the newest end before fresh IDs are appended.
fn record(
    state: &mut State,
    key: &PositionKey,
    events: &[Event],
) -> Result<usize, StoreError> {
    let mut distinct = BTreeSet::new();
    let mut repeats = Vec::new();
    let mut fresh = Vec::new();
    let pending_room = MAX_PENDING_EVENTS
        .saturating_sub(state.pending.get(key).map_or(0, VecDeque::len));
    let room = pending_room.min(MAX_SEEN_IDS);
    let limit = if pending_room < MAX_SEEN_IDS {
        MAX_PENDING_EVENTS
    } else {
        MAX_SEEN_IDS
    };

    for event in events {
        let id = event.id();

        if !distinct.insert(id) {
            continue;
        }

        if state.seen.get(key).is_some_and(|seen| seen.contains(id)) {
            repeats.push(id.clone());
        } else {
            if fresh.len() == room {
                return Err(StoreError::TooMany { limit });
            }

            fresh.push(event);
        }
    }

    if distinct.is_empty() {
        return Ok(0);
    }

    let seen = state.seen.entry(key.clone()).or_default();

    for id in repeats {
        if let Some(index) = seen.iter().position(|known| *known == id) {
            seen.remove(index);
        }

        seen.push_back(id);
    }

    if fresh.is_empty() {
        return Ok(0);
    }

    let new_count = fresh.len();
    evict(state.pending.get(key), seen, new_count)?;
    let pending = state.pending.entry(key.clone()).or_default();

    for event in fresh {
        seen.push_back(event.id().clone());
        pending.push_back(event.clone());
    }

    Ok(new_count)
}

// Drops only the oldest IDs with no pending event. Every pending ID, including
// those of fresh events, stays remembered after the commit.
fn evict(
    pending: Option<&VecDeque<Event>>,
    seen: &mut VecDeque<EventId>,
    new_count: usize,
) -> Result<(), StoreError> {
    let count = seen
        .len()
        .saturating_add(new_count)
        .saturating_sub(MAX_SEEN_IDS);

    if count == 0 {
        return Ok(());
    }

    let pending_ids: BTreeSet<_> =
        pending.into_iter().flatten().map(Event::id).collect();

    for _ in 0..count {
        let Some(index) = seen.iter().position(|id| !pending_ids.contains(id))
        else {
            return Err(StoreError::TooMany {
                limit: MAX_SEEN_IDS,
            });
        };

        seen.remove(index);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::ops::Range;

    use super::*;
    use sourcefed_core::{EventKind, EventSubject, SourceName};

    fn key(index: usize) -> PositionKey {
        PositionKey {
            monitor: sourcefed_core::MonitorId::new(format!("monitor-{index}"))
                .unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        }
    }

    fn event(id: String) -> Event {
        let source = SourceName::new("timer".into()).unwrap();
        let subject = EventSubject::new(source, "deploy".into()).unwrap();
        let at = "2026-01-01T00:00:00Z".parse().unwrap();

        Event::new(
            EventId::new(id).unwrap(),
            EventKind::TimerFired,
            subject,
            "fired".into(),
            at,
        )
        .unwrap()
    }

    fn events(range: Range<usize>) -> Vec<Event> {
        range.map(|index| event(format!("event-{index}"))).collect()
    }

    fn cursor() -> Position {
        Position::new("cursor".into()).unwrap()
    }

    fn ids(events: &[Event]) -> Vec<EventId> {
        events.iter().map(|event| event.id().clone()).collect()
    }

    fn assert_fault(error: StoreError, reason: &str) {
        let StoreError::Write { path, source } = error else {
            panic!("expected a write fault, got {error:?}");
        };

        assert_eq!(path, PathBuf::from("sim"));
        assert_eq!(source.to_string(), reason);
    }

    fn assert_too_many(error: &StoreError, limit: usize) {
        let StoreError::TooMany { limit: actual } = error else {
            panic!("expected too many, got {error:?}");
        };

        assert_eq!(*actual, limit);
    }

    #[test]
    fn commit_saves_position_seen_ids_and_pending_events() {
        let mut store = MemoryStore::new();
        let batch = events(0..2);

        assert_eq!(store.position(&key(1)), None);
        assert_eq!(store.pending(&key(1)), None);
        assert_eq!(store.commit(key(1), cursor(), &batch).unwrap(), 2);
        assert_eq!(store.position(&key(1)), Some(cursor()));
        assert_eq!(store.pending(&key(1)), Some(VecDeque::from(batch.clone())));
        assert!(store.is_seen(&key(1), batch[0].id()));
        assert!(!store.is_seen(&key(2), batch[0].id()));
        assert_eq!(store.commit(key(1), cursor(), &batch).unwrap(), 0);
        assert_eq!(store.pending(&key(1)), Some(VecDeque::from(batch)));
    }

    #[test]
    fn ack_removes_pending_events_without_forgetting_their_ids() {
        let mut store = MemoryStore::new();
        let batch = events(0..3);
        let unknown = EventId::new("unknown".into()).unwrap();
        store.commit(key(1), cursor(), &batch).unwrap();

        assert_eq!(store.ack_pending(&key(1), &[]).unwrap(), 0);
        assert_eq!(store.ack_pending(&key(1), &[unknown]).unwrap(), 0);
        assert_eq!(store.ack_pending(&key(1), &ids(&batch[1..3])).unwrap(), 2);
        assert_eq!(
            store.pending(&key(1)),
            Some(VecDeque::from(vec![batch[0].clone()]))
        );
        assert!(store.is_seen(&key(1), batch[1].id()));
        assert!(store.is_seen(&key(1), batch[2].id()));
        assert_eq!(store.ack_pending(&key(1), &ids(&batch)).unwrap(), 1);
        assert_eq!(store.pending(&key(1)), Some(VecDeque::new()));
        assert_eq!(store.position(&key(1)), Some(cursor()));
    }

    #[test]
    fn ack_reports_exactly_how_many_pending_events_it_removed() {
        let mut store = MemoryStore::new();
        let batch = events(0..4);
        store.commit(key(1), cursor(), &batch).unwrap();

        assert_eq!(store.ack_pending(&key(1), &ids(&batch[..2])).unwrap(), 2);
        assert_eq!(
            store.pending(&key(1)),
            Some(VecDeque::from(vec![batch[2].clone(), batch[3].clone()]))
        );
        assert_eq!(store.ack_pending(&key(1), &ids(&batch[2..])).unwrap(), 2);
        assert_eq!(store.pending(&key(1)), Some(VecDeque::new()));
    }

    #[test]
    fn a_full_pending_queue_refuses_fresh_events() {
        let mut store = MemoryStore::new();
        let initial = events(0..MAX_PENDING_EVENTS);
        let fresh = events(MAX_PENDING_EVENTS..MAX_PENDING_EVENTS + 1);
        store.commit(key(1), cursor(), &initial).unwrap();

        assert_too_many(
            &store
                .commit(key(1), Position::new("next".into()).unwrap(), &fresh)
                .unwrap_err(),
            MAX_PENDING_EVENTS,
        );
        assert_eq!(store.position(&key(1)), Some(cursor()));
        assert_eq!(store.pending(&key(1)), Some(VecDeque::from(initial)));
        assert!(!store.is_seen(&key(1), fresh[0].id()));
        assert_eq!(
            store
                .ack_pending(&key(1), &ids(&events(0..MAX_PENDING_EVENTS)))
                .unwrap(),
            MAX_PENDING_EVENTS
        );
        assert_eq!(store.commit(key(1), cursor(), &fresh).unwrap(), 1);
    }

    #[test]
    fn an_oversized_batch_refuses_without_changing_state() {
        let mut store = MemoryStore::new();
        let batch = events(0..MAX_SEEN_IDS + 1);

        assert_too_many(
            &store.commit(key(1), cursor(), &batch).unwrap_err(),
            MAX_SEEN_IDS,
        );
        assert_eq!(store.position(&key(1)), None);
        assert_eq!(store.pending(&key(1)), None);
        assert!(!store.is_seen(&key(1), batch[0].id()));
    }

    #[test]
    fn a_new_key_is_refused_after_the_position_limit() {
        let mut store = MemoryStore::new();

        for index in 0..MAX_POSITIONS {
            assert_eq!(store.commit(key(index), cursor(), &[]).unwrap(), 0);
        }

        assert_too_many(
            &store.commit(key(MAX_POSITIONS), cursor(), &[]).unwrap_err(),
            MAX_POSITIONS,
        );
        assert_eq!(store.position(&key(0)), Some(cursor()));
        assert_eq!(store.position(&key(MAX_POSITIONS)), None);
    }

    #[test]
    fn eviction_never_drops_an_id_that_is_still_pending() {
        let mut store = MemoryStore::new();
        let initial = events(0..MAX_SEEN_IDS);
        let fresh = events(MAX_SEEN_IDS..MAX_SEEN_IDS + 1);
        store.commit(key(1), cursor(), &initial).unwrap();

        assert_too_many(
            &store.commit(key(1), cursor(), &fresh).unwrap_err(),
            MAX_PENDING_EVENTS,
        );
        assert!(store.is_seen(&key(1), initial[0].id()));
        assert_eq!(
            store.ack_pending(&key(1), &ids(&initial[1..])).unwrap(),
            MAX_SEEN_IDS - 1
        );
        assert_eq!(store.commit(key(1), cursor(), &fresh).unwrap(), 1);
        assert!(store.is_seen(&key(1), initial[0].id()));
        assert!(!store.is_seen(&key(1), initial[1].id()));
        assert!(store.is_seen(&key(1), fresh[0].id()));
    }

    #[test]
    fn scripted_commit_fault_leaves_state_unchanged() {
        let mut store = MemoryStore::new();
        store.script(StoreControl::CommitFault);
        let batch = events(0..1);

        assert_fault(
            store.commit(key(1), cursor(), &batch).unwrap_err(),
            "scripted commit fault",
        );
        assert_eq!(store.position(&key(1)), None);
        assert_eq!(store.pending(&key(1)), None);
        assert!(!store.is_seen(&key(1), batch[0].id()));
        assert_eq!(store.commit(key(1), cursor(), &batch).unwrap(), 1);
    }

    #[test]
    fn scripted_ack_fault_leaves_state_unchanged() {
        let mut store = MemoryStore::new();
        let batch = events(0..2);
        store.commit(key(1), cursor(), &batch).unwrap();
        store.script(StoreControl::AckFault);

        assert_fault(
            store.ack_pending(&key(1), &ids(&batch)).unwrap_err(),
            "scripted ack fault",
        );
        assert_eq!(store.pending(&key(1)), Some(VecDeque::from(batch.clone())));
        assert_eq!(store.ack_pending(&key(1), &ids(&batch)).unwrap(), 2);
        assert_eq!(store.pending(&key(1)), Some(VecDeque::new()));
    }
}
