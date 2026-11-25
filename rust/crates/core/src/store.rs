use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Event, EventId, MonitorId, Position, SourceName};

/// Maximum size of the serialized store, in bytes.
pub const MAX_STORE_BYTES: usize = 262_144;
/// Maximum number of stored positions.
pub const MAX_POSITIONS: usize = 256;
/// Maximum number of remembered event IDs.
pub const MAX_SEEN_IDS: usize = 1000;

// Read one byte past the accepted size to detect an oversized file.
const MAX_READ_BYTES: u64 = 262_145;
const STORE_VERSION: u8 = 1;

/// Identifies a position by monitor and source.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct PositionKey {
    /// The monitor that owns the position.
    pub monitor: MonitorId,
    /// The source that supplies the position.
    pub source: SourceName,
}

/// A store cannot be opened or its state cannot be saved.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Reading the file fails; inspect the path and underlying I/O error.
    #[error("could not read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    /// Writing fails; inspect the path and underlying I/O error.
    #[error("could not write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    /// The file is invalid; inspect or restore it before opening the store.
    #[error("corrupt store {path}: {reason}")]
    Corrupt { path: PathBuf, reason: &'static str },
    /// The position limit is reached; reduce the number of stored positions.
    #[error("state exceeds {limit} positions")]
    TooMany { limit: usize },
    /// The byte limit is exceeded; reduce the size of the state to save.
    #[error("state exceeds {limit} bytes")]
    TooLarge { limit: usize },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct State {
    version: u8,
    #[serde(with = "position_entries")]
    positions: BTreeMap<PositionKey, Position>,
    seen: VecDeque<EventId>,
}

impl State {
    const fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            positions: BTreeMap::new(),
            seen: VecDeque::new(),
        }
    }

    fn load(path: &Path) -> Result<Self, StoreError> {
        let read_error = |source| StoreError::Read {
            path: path.to_owned(),
            source,
        };
        let corrupt = |reason| StoreError::Corrupt {
            path: path.to_owned(),
            reason,
        };
        let file = match File::open(path) {
            Ok(file) => file,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                return Ok(Self::empty());
            }
            Err(source) => return Err(read_error(source)),
        };

        let mut bytes = Vec::new();
        file.take(MAX_READ_BYTES)
            .read_to_end(&mut bytes)
            .map_err(read_error)?;

        if bytes.len() > MAX_STORE_BYTES {
            return Err(corrupt("file exceeds byte limit"));
        }

        let state: Self =
            serde_json::from_slice(&bytes).map_err(|_| corrupt("invalid json"))?;

        if let Some(reason) = state.invalid_reason() {
            return Err(corrupt(reason));
        }

        Ok(state)
    }

    fn invalid_reason(&self) -> Option<&'static str> {
        if self.version != STORE_VERSION {
            return Some("unsupported version");
        }
        if self.positions.len() > MAX_POSITIONS {
            return Some("too many positions");
        }
        if self.seen.len() > MAX_SEEN_IDS {
            return Some("too many seen ids");
        }

        let mut unique = BTreeSet::new();

        if self.seen.iter().any(|id| !unique.insert(id)) {
            return Some("duplicate seen id");
        }

        None
    }

    fn record(&mut self, events: &[Event]) -> usize {
        let mut count = 0usize;

        for event in events {
            let id = event.id();

            if self.seen.contains(id) {
                continue;
            }

            if self.seen.len() == MAX_SEEN_IDS {
                self.seen.pop_front();
            }

            self.seen.push_back(id.clone());
            count = count.saturating_add(1);
        }

        count
    }
}

// JSON object keys cannot hold a PositionKey struct, so use a sequence of pairs.
mod position_entries {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serializer, de};

    use super::{Position, PositionKey};

    pub(super) fn serialize<S: Serializer>(
        positions: &BTreeMap<PositionKey, Position>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(positions)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<PositionKey, Position>, D::Error> {
        let entries = Vec::<(PositionKey, Position)>::deserialize(deserializer)?;
        let mut positions = BTreeMap::new();

        for (key, position) in entries {
            if positions.insert(key, position).is_some() {
                return Err(de::Error::custom("duplicate position key"));
            }
        }

        Ok(positions)
    }
}

/// Stores positions and seen IDs in a versioned JSON object.
///
/// The object has a version, a sequence of position key and position pairs,
/// and a sequence of seen event IDs. At the ID limit, the oldest ID is dropped.
#[derive(Debug)]
pub struct Store {
    path: PathBuf,
    state: State,
}

impl Store {
    /// Opens a store in the directory, or starts empty if its file is absent.
    ///
    /// A corrupt file is refused without rewriting it.
    ///
    /// # Errors
    /// Returns [`StoreError::Write`] if directory creation fails,
    /// [`StoreError::Read`] if the file cannot be read, or
    /// [`StoreError::Corrupt`] if the file is invalid or exceeds its limits.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(dir).map_err(|source| StoreError::Write {
            path: dir.to_owned(),
            source,
        })?;
        let path = dir.join("positions.json");
        let state = State::load(&path)?;

        Ok(Self { path, state })
    }

    /// Returns the saved position for the key, if one exists.
    #[must_use]
    pub fn position(&self, key: &PositionKey) -> Option<&Position> {
        self.state.positions.get(key)
    }

    /// Returns whether the event ID is in the bounded set of remembered IDs.
    #[must_use]
    pub fn is_seen(&self, id: &EventId) -> bool {
        self.state.seen.contains(id)
    }

    /// Saves the position and event IDs, returning the count of new IDs.
    ///
    /// Only IDs not remembered when encountered count as new. The oldest IDs
    /// are dropped as needed to keep the set bounded. The position is saved
    /// even when no event is new. The state is written to a temporary file and
    /// renamed into place.
    ///
    /// # Errors
    /// Returns [`StoreError::TooMany`] if a new key exceeds the position limit,
    /// [`StoreError::TooLarge`] if the serialized state exceeds the byte limit,
    /// or [`StoreError::Write`] if serialization, writing or renaming fails.
    pub fn commit(
        &mut self,
        key: PositionKey,
        position: Position,
        events: &[Event],
    ) -> Result<usize, StoreError> {
        if self.state.positions.len() == MAX_POSITIONS
            && !self.state.positions.contains_key(&key)
        {
            return Err(StoreError::TooMany {
                limit: MAX_POSITIONS,
            });
        }

        let mut state = self.state.clone();
        let count = state.record(events);
        state.positions.insert(key, position);
        self.persist(&state)?;

        self.state = state;

        Ok(count)
    }

    fn persist(&self, state: &State) -> Result<(), StoreError> {
        let bytes =
            serde_json::to_vec(state).map_err(|error| StoreError::Write {
                path: self.path.clone(),
                source: error.into(),
            })?;

        if bytes.len() > MAX_STORE_BYTES {
            return Err(StoreError::TooLarge {
                limit: MAX_STORE_BYTES,
            });
        }

        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|source| StoreError::Write {
            path: tmp.clone(),
            source,
        })?;
        fs::rename(&tmp, &self.path).map_err(|source| StoreError::Write {
            path: self.path.clone(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EventKind, EventSubject, MAX_ID_LEN};

    fn key(index: usize) -> PositionKey {
        PositionKey {
            monitor: MonitorId::new(format!("monitor-{index}")).unwrap(),
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
            "deploy".into(),
            at,
        )
        .unwrap()
    }

    fn assert_corrupt(dir: &Path, path: &Path, reason: &str) {
        let error = Store::open(dir).unwrap_err();

        let StoreError::Corrupt {
            path: actual_path,
            reason: actual_reason,
        } = error
        else {
            panic!("expected corrupt store, got {error:?}");
        };

        assert_eq!(actual_path.as_path(), path);
        assert_eq!(actual_reason, reason);
    }

    fn assert_missing(path: &Path) {
        assert_eq!(
            fs::metadata(path).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    fn state_at_byte_limit() -> (State, PositionKey, Position) {
        let mut state = State::empty();
        let suffix = "x".repeat(MAX_ID_LEN - 4);
        state.seen = (0..MAX_SEEN_IDS)
            .map(|index| EventId::new(format!("{index:04}{suffix}")).unwrap())
            .collect();

        let key = key(1);
        state
            .positions
            .insert(key.clone(), Position::new("x".into()).unwrap());
        let bytes = serde_json::to_vec(&state).unwrap();
        let overhead = bytes.len().checked_sub(1).unwrap();
        let position_len = MAX_STORE_BYTES.checked_sub(overhead).unwrap();
        let position = Position::new("x".repeat(position_len)).unwrap();
        state.positions.insert(key.clone(), position.clone());

        (state, key, position)
    }

    fn state_with_counts(positions: usize, seen: usize) -> State {
        let position = Position::new("cursor".into()).unwrap();

        State {
            version: STORE_VERSION,
            positions: (0..positions)
                .map(|index| (key(index), position.clone()))
                .collect(),
            seen: (0..seen)
                .map(|index| EventId::new(format!("event-{index}")).unwrap())
                .collect(),
        }
    }

    #[test]
    fn positions_and_seen_ids_survive_reopen_without_duplicate_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store_dir = dir.path().join("store");
        let key = key(1);
        let position = Position::new("cursor".into()).unwrap();
        let events = [event("deploy-1".into())];
        let event_id = events.first().unwrap().id();
        let mut store = Store::open(&store_dir).unwrap();

        assert_eq!(
            store
                .commit(key.clone(), position.clone(), &events)
                .unwrap(),
            1
        );

        let mut reopened = Store::open(&store_dir).unwrap();

        assert_eq!(
            (reopened.position(&key), reopened.is_seen(event_id)),
            (Some(&position), true)
        );
        assert_eq!(reopened.commit(key, position, &events).unwrap(), 0);

        let reopened = Store::open(&store_dir).unwrap();
        let other = event("deploy-2".into());

        assert_eq!(
            (reopened.is_seen(event_id), reopened.is_seen(other.id())),
            (true, false)
        );
    }

    #[test]
    fn malformed_json_is_refused_without_rewriting_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("positions.json");
        fs::write(&path, b"{").unwrap();

        assert_corrupt(dir.path(), &path, "invalid json");
        assert_eq!(fs::read(&path).unwrap().as_slice(), b"{");
    }

    #[test]
    fn oversized_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("positions.json");
        fs::write(&path, vec![b' '; MAX_STORE_BYTES + 1]).unwrap();

        assert_corrupt(dir.path(), &path, "file exceeds byte limit");
    }

    #[test]
    fn state_at_the_byte_limit_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("positions.json");
        let (state, key, position) = state_at_byte_limit();
        let bytes = serde_json::to_vec(&state).unwrap();

        assert_eq!(bytes.len(), MAX_STORE_BYTES);
        fs::write(&path, bytes).unwrap();

        let store = Store::open(dir.path()).unwrap();
        let id = state.seen.front().unwrap();

        assert_eq!(
            (store.position(&key), store.is_seen(id)),
            (Some(&position), true)
        );
    }

    #[test]
    fn max_positions_and_seen_ids_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("positions.json");
        let state = state_with_counts(MAX_POSITIONS, MAX_SEEN_IDS);
        fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();

        let store = Store::open(dir.path()).unwrap();
        let position = Position::new("cursor".into()).unwrap();

        assert_eq!(store.position(&key(0)), Some(&position));
    }

    #[test]
    fn invalid_state_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let wrong_version = State {
            version: 0,
            ..State::empty()
        };
        let id = EventId::new("duplicate".into()).unwrap();
        let duplicate_seen_ids = State {
            seen: VecDeque::from([id.clone(), id]),
            ..State::empty()
        };

        for (state, reason) in [
            (wrong_version, "unsupported version"),
            (
                state_with_counts(MAX_POSITIONS + 1, 0),
                "too many positions",
            ),
            (state_with_counts(0, MAX_SEEN_IDS + 1), "too many seen ids"),
            (duplicate_seen_ids, "duplicate seen id"),
        ] {
            let store_dir = dir.path().join(reason);
            let path = store_dir.join("positions.json");
            fs::create_dir(&store_dir).unwrap();
            fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();

            assert_corrupt(&store_dir, &path, reason);
        }
    }

    #[test]
    fn non_not_found_open_errors_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        fs::write(&file, b"").unwrap();
        let path = file.join("positions.json");

        let error = State::load(&path).unwrap_err();
        let StoreError::Read {
            path: actual_path,
            source,
        } = error
        else {
            panic!("expected read error, got {error:?}");
        };

        assert_eq!(actual_path, path);
        assert_eq!(source.kind(), io::ErrorKind::NotADirectory);
    }

    #[test]
    fn position_overflow_does_not_change_state_or_write_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let position = Position::new("cursor".into()).unwrap();
        store.state.positions = (0..MAX_POSITIONS)
            .map(|index| (key(index), position.clone()))
            .collect();
        let before = store.state.clone();

        let error = store.commit(key(MAX_POSITIONS), position, &[]).unwrap_err();
        let StoreError::TooMany { limit } = error else {
            panic!("expected too many positions, got {error:?}");
        };

        assert_eq!(limit, MAX_POSITIONS);
        assert_eq!(store.state, before);
        assert_missing(&store.path);
        assert_missing(&store.path.with_extension("tmp"));
    }

    #[test]
    fn commit_leaves_the_final_state_and_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let position = Position::new("cursor".into()).unwrap();
        let path = dir.path().join("positions.json");

        assert_eq!(store.commit(key(1), position, &[]).unwrap(), 0);
        assert_missing(&path.with_extension("tmp"));

        let bytes = fs::read(&path).unwrap();

        assert_eq!(
            serde_json::from_slice::<State>(&bytes).unwrap(),
            store.state
        );
    }

    #[test]
    fn persist_at_the_byte_limit_writes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let (state, key, position) = state_at_byte_limit();

        assert_eq!(
            store.persist(&state).map_err(|error| error.to_string()),
            Ok(())
        );
        assert_eq!(fs::read(&store.path).unwrap().len(), MAX_STORE_BYTES);

        let reopened = Store::open(dir.path()).unwrap();

        assert_eq!(reopened.position(&key), Some(&position));
    }

    #[test]
    fn byte_overflow_leaves_the_previous_state_and_file_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let position = Position::new("cursor".into()).unwrap();
        assert_eq!(store.commit(key(1), position.clone(), &[]).unwrap(), 0);
        let before = store.state.clone();
        let bytes = fs::read(&store.path).unwrap();

        // The maximum-length IDs expand when their quotes are escaped in JSON.
        let suffix = "\"".repeat(MAX_ID_LEN - 4);
        let events: Vec<_> = (0..MAX_SEEN_IDS)
            .map(|index| event(format!("{index:04}{suffix}")))
            .collect();

        let error = store.commit(key(2), position, &events).unwrap_err();
        let StoreError::TooLarge { limit } = error else {
            panic!("expected state too large, got {error:?}");
        };

        assert_eq!(limit, MAX_STORE_BYTES);
        assert_eq!(store.state, before);
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
        assert_missing(&store.path.with_extension("tmp"));
    }
}
