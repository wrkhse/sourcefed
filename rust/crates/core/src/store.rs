use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{Event, EventId, MonitorId, Position, SourceName};

/// Maximum size of the serialized store, in bytes.
pub const MAX_STORE_BYTES: usize = 262_144;
/// Maximum number of stored positions.
pub const MAX_POSITIONS: usize = 256;
/// Maximum number of remembered event IDs for each position key.
pub const MAX_SEEN_IDS: usize = 1000;

// Read one byte past the accepted size to detect an oversized file.
const MAX_READ_BYTES: u64 = 262_145;
const STORE_VERSION: u8 = 1;
const STORE_FILE: &str = "positions.json";
const LOCK_FILE: &str = "positions.lock";
// Bounds the directory entries one open inspects for leftover temp files.
const MAX_TEMP_SCAN: usize = 500;
// Bounds the leftover temp files one open removes.
const MAX_TEMP_REMOVE: usize = 100;

// Numbers temporary files so concurrent writes in one process never collide.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    ///
    /// Removing leftover temporary files never returns this error.
    #[error("could not write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    /// The file is invalid JSON, has an unsupported version, or breaks a limit.
    ///
    /// The reason names the problem; for invalid JSON it gives serde's line
    /// and column. Inspect or restore the file before opening the store.
    #[error("corrupt store {path}: {reason}")]
    Corrupt { path: PathBuf, reason: String },
    /// Another store holds the directory; close it before opening again.
    #[error("store {path} is locked by another writer")]
    Locked { path: PathBuf },
    /// A count limit is reached: a new key would exceed the position limit, or
    /// one commit holds more new IDs than the seen ID limit. Reduce the
    /// positions or split the batch.
    #[error("state exceeds {limit} items")]
    TooMany { limit: usize },
    /// The byte limit is exceeded; reduce the size of the state to save.
    #[error("state exceeds {limit} bytes")]
    TooLarge { limit: usize },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct State {
    version: u8,
    #[serde(with = "key_entries")]
    positions: BTreeMap<PositionKey, Position>,
    #[serde(with = "key_entries")]
    seen: BTreeMap<PositionKey, VecDeque<EventId>>,
}

impl State {
    const fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            positions: BTreeMap::new(),
            seen: BTreeMap::new(),
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
            return Err(corrupt("file exceeds byte limit".to_owned()));
        }

        let state: Self = serde_json::from_slice(&bytes).map_err(|error| {
            corrupt(format!(
                "invalid json at line {} column {}",
                error.line(),
                error.column()
            ))
        })?;

        if let Some(reason) = state.invalid_reason() {
            return Err(corrupt(reason.to_owned()));
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

        for ids in self.seen.values() {
            if ids.len() > MAX_SEEN_IDS {
                return Some("too many seen ids");
            }

            let mut unique = BTreeSet::new();

            if ids.iter().any(|id| !unique.insert(id)) {
                return Some("duplicate seen id");
            }
        }

        None
    }

    fn record(
        &mut self,
        key: &PositionKey,
        events: &[Event],
    ) -> Result<usize, StoreError> {
        let known = self.seen.get(key);
        let mut distinct = BTreeSet::new();
        let mut repeats = Vec::new();
        let mut fresh = Vec::new();

        // Split the batch against the IDs remembered before it, so refreshing
        // a repeat can never evict an ID this batch adds.
        for id in events.iter().map(Event::id) {
            if !distinct.insert(id) {
                continue;
            }

            if known.is_some_and(|seen| seen.contains(id)) {
                repeats.push(id);
            } else {
                fresh.push(id);
            }
        }

        let new_count = fresh.len();

        if new_count > MAX_SEEN_IDS {
            return Err(StoreError::TooMany {
                limit: MAX_SEEN_IDS,
            });
        }

        if distinct.is_empty() {
            return Ok(0);
        }

        let seen = self.seen.entry(key.clone()).or_default();

        // A repeat is already in the queue, so moving it never grows it.
        for id in repeats {
            if let Some(index) = seen.iter().position(|known| known == id) {
                seen.remove(index);
            }

            seen.push_back(id.clone());
        }

        for id in fresh {
            if seen.len() == MAX_SEEN_IDS {
                seen.pop_front();
            }

            seen.push_back(id.clone());
        }

        Ok(new_count)
    }
}

// JSON object keys cannot hold a PositionKey struct, so use a sequence of pairs.
mod key_entries {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

    use super::PositionKey;

    pub(super) fn serialize<S: Serializer, V: Serialize>(
        entries: &BTreeMap<PositionKey, V>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(entries)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>, V: Deserialize<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<PositionKey, V>, D::Error> {
        let pairs = Vec::<(PositionKey, V)>::deserialize(deserializer)?;
        let mut entries = BTreeMap::new();

        for (key, value) in pairs {
            if entries.insert(key, value).is_some() {
                return Err(de::Error::custom("duplicate position key"));
            }
        }

        Ok(entries)
    }
}

/// Stores positions and seen IDs in a versioned JSON object.
///
/// The object has a version, a sequence of position key and position pairs,
/// and a sequence of position key and seen event ID pairs. Each key remembers
/// its own IDs in a bounded queue. A repeated ID moves to the newest end; at
/// the ID limit, the oldest ID is dropped. Only one store at a time may hold a
/// directory.
#[derive(Debug)]
pub struct Store {
    dir: PathBuf,
    path: PathBuf,
    state: State,
    // Held for the store's lifetime so a second writer is refused.
    _lock: File,
}

impl Store {
    /// Opens a store in the directory, or starts empty if its file is absent.
    ///
    /// After acquiring the exclusive lock, removes up to 100 leftover temporary
    /// files that the store itself generated, scanning at most 500 directory
    /// entries. A generated name is the store file name followed by a nonzero
    /// `u32` process ID, a `u64` counter and `.tmp`; other files are left
    /// alone. Cleanup
    /// failures are ignored, so a stray file cannot block opening a healthy
    /// store. A corrupt file is refused without rewriting it. The directory
    /// stays locked until the store is dropped.
    ///
    /// # Errors
    /// Returns [`StoreError::Write`] if directory or lock file creation has an
    /// I/O failure,
    /// [`StoreError::Locked`] if another store holds the directory,
    /// [`StoreError::Read`] if the file cannot be read, or
    /// [`StoreError::Corrupt`] if the file is invalid or exceeds its limits.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        Self::open_with_cleanup(dir, cleanup_temp_files)
    }

    // Opens the store with the given temp file cleanup, so tests can control
    // the directory entries it sees. The cleanup runs while the lock is held.
    fn open_with_cleanup(
        dir: &Path,
        cleanup: impl FnOnce(&Path) -> usize,
    ) -> Result<Self, StoreError> {
        fs::create_dir_all(dir).map_err(|source| StoreError::Write {
            path: dir.to_owned(),
            source,
        })?;
        let lock = lock(dir)?;
        cleanup(dir);
        let path = dir.join(STORE_FILE);
        let state = State::load(&path)?;

        Ok(Self {
            dir: dir.to_owned(),
            path,
            state,
            _lock: lock,
        })
    }

    /// Returns the saved position for the key, if one exists.
    #[must_use]
    pub fn position(&self, key: &PositionKey) -> Option<&Position> {
        self.state.positions.get(key)
    }

    /// Returns whether the event ID is among the key's remembered IDs.
    ///
    /// Each key remembers its own bounded set, so an ID seen under one key is
    /// not seen under another.
    #[must_use]
    pub fn is_seen(&self, key: &PositionKey, id: &EventId) -> bool {
        self.state.seen.get(key).is_some_and(|ids| ids.contains(id))
    }

    /// Saves the position and event IDs, returning the count of new IDs.
    ///
    /// Only distinct IDs not already remembered for the key count as new.
    /// Repeated IDs move to the newest end of the key's queue first, then the
    /// new IDs are appended after them, so a refresh never drops a new ID. The
    /// oldest IDs are dropped as needed to keep the queue bounded. The
    /// position is saved even when no event is new. The state is written to
    /// a temporary file, synced, renamed into place, and the directory synced.
    ///
    /// # Errors
    /// Returns [`StoreError::TooMany`] if a new key exceeds the position limit
    /// or the batch holds more new IDs than the seen ID limit,
    /// [`StoreError::TooLarge`] if the serialized state exceeds the byte limit,
    /// or [`StoreError::Write`] if serialization, writing, syncing or renaming
    /// fails. On error, memory and the saved file are unchanged.
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
        let count = state.record(&key, events)?;
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

        let tmp = self.temp_path();
        let replaced = write_synced(&tmp, &bytes)
            .map_err(|source| StoreError::Write {
                path: tmp.clone(),
                source,
            })
            .and_then(|()| {
                fs::rename(&tmp, &self.path).map_err(|source| StoreError::Write {
                    path: self.path.clone(),
                    source,
                })
            });

        if let Err(error) = replaced {
            // Best effort: the write error matters more than a failed cleanup.
            let _ = fs::remove_file(&tmp);

            return Err(error);
        }

        // The rename is durable only once the directory entry is synced.
        #[cfg(unix)]
        File::open(&self.dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|source| StoreError::Write {
                path: self.dir.clone(),
                source,
            })?;

        Ok(())
    }

    fn temp_path(&self) -> PathBuf {
        let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!("{STORE_FILE}.{}.{count}.tmp", process::id());

        self.dir.join(name)
    }
}

// Best effort: a stray or unreadable entry must never stop a healthy store
// from opening, so every I/O failure here is ignored. Returns how many raw
// directory entries were examined, at most `MAX_TEMP_SCAN`.
fn cleanup_temp_files(dir: &Path) -> usize {
    fs::read_dir(dir).map_or(0, cleanup_entries)
}

// Cleans up among the first `MAX_TEMP_SCAN` raw entries and returns how many
// were examined. Unreadable entries are skipped but still examined.
fn cleanup_entries(
    entries: impl Iterator<Item = io::Result<fs::DirEntry>>,
) -> usize {
    // The limit applies to raw entries, so unreadable ones count toward it too.
    let raw: Vec<_> = entries.take(MAX_TEMP_SCAN).collect();
    let examined = raw.len();
    let paths = raw
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.path());

    cleanup_paths(paths);

    examined
}

// Removes generated temp files among the first `MAX_TEMP_SCAN` paths, at most
// `MAX_TEMP_REMOVE` of them, and returns how many were removed.
fn cleanup_paths(paths: impl Iterator<Item = PathBuf>) -> usize {
    let mut removed = 0_usize;

    for path in paths.take(MAX_TEMP_SCAN) {
        let generated = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_generated_temp_name);
        // symlink_metadata keeps a link to a file from counting as a file.
        let is_file = fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file());

        if generated && is_file && fs::remove_file(&path).is_ok() {
            removed = removed.saturating_add(1);
        }

        if removed == MAX_TEMP_REMOVE {
            break;
        }
    }

    removed
}

// Accepts only the form `Store::temp_path` generates, so a user's file that
// merely resembles it is left alone.
fn is_generated_temp_name(name: &str) -> bool {
    let numbers = name
        .strip_prefix(STORE_FILE)
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(".tmp"));

    numbers
        .and_then(|numbers| numbers.split_once('.'))
        .is_some_and(|(pid, count)| {
            let pid = parse_decimal::<u32>(pid);

            pid.is_some_and(|pid| pid > 0) && parse_decimal::<u64>(count).is_some()
        })
}

// Accepts only how Rust formats an unsigned integer: digits alone, with no
// leading zero unless the number is zero, and within the type's range.
fn parse_decimal<T: FromStr>(text: &str) -> Option<T> {
    let canonical = text == "0" || !text.starts_with('0');
    let digits = text.bytes().all(|byte| byte.is_ascii_digit());

    if canonical && digits {
        text.parse().ok()
    } else {
        None
    }
}

fn lock(dir: &Path) -> Result<File, StoreError> {
    let path = dir.join(LOCK_FILE);
    let file = File::options()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|source| StoreError::Write {
            path: path.clone(),
            source,
        })?;

    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(StoreError::Locked { path }),
        Err(TryLockError::Error(source)) => Err(StoreError::Write { path, source }),
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;

    file.sync_all()
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

    fn events(range: std::ops::Range<usize>) -> Vec<Event> {
        range.map(|index| event(format!("event-{index}"))).collect()
    }

    fn cursor() -> Position {
        Position::new("cursor".into()).unwrap()
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

    fn assert_no_temp_files(dir: &Path) {
        let temp_files: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().ends_with(".tmp"))
            .collect();

        assert_eq!(temp_files, Vec::<std::ffi::OsString>::new());
    }

    fn state_at_byte_limit() -> (State, PositionKey, Position) {
        let mut state = State::empty();
        let suffix = "x".repeat(MAX_ID_LEN - 4);
        let key = key(1);
        let ids = (0..MAX_SEEN_IDS)
            .map(|index| EventId::new(format!("{index:04}{suffix}")).unwrap())
            .collect();
        state.seen.insert(key.clone(), ids);

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
        let ids = (0..seen)
            .map(|index| EventId::new(format!("event-{index}")).unwrap())
            .collect();

        State {
            version: STORE_VERSION,
            positions: (0..positions).map(|index| (key(index), cursor())).collect(),
            seen: BTreeMap::from([(key(0), ids)]),
        }
    }

    #[test]
    fn positions_and_seen_ids_survive_reopen_without_duplicate_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store_dir = dir.path().join("store");
        let key = key(1);
        let position = cursor();
        let events = [event("deploy-1".into())];
        let event_id = events.first().unwrap().id();
        let mut store = Store::open(&store_dir).unwrap();

        assert_eq!(
            store
                .commit(key.clone(), position.clone(), &events)
                .unwrap(),
            1
        );
        drop(store);

        let mut reopened = Store::open(&store_dir).unwrap();

        assert_eq!(
            (reopened.position(&key), reopened.is_seen(&key, event_id)),
            (Some(&position), true)
        );
        assert_eq!(reopened.commit(key.clone(), position, &events).unwrap(), 0);
        drop(reopened);

        let reopened = Store::open(&store_dir).unwrap();
        let other = event("deploy-2".into());

        assert_eq!(
            (
                reopened.is_seen(&key, event_id),
                reopened.is_seen(&key, other.id())
            ),
            (true, false)
        );
    }

    #[test]
    fn a_second_open_of_the_same_directory_is_locked() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();

        let error = Store::open(dir.path()).unwrap_err();
        let StoreError::Locked { path } = error else {
            panic!("expected locked store, got {error:?}");
        };

        assert_eq!(path, dir.path().join(LOCK_FILE));

        drop(store);

        assert_eq!(Store::open(dir.path()).unwrap().position(&key(1)), None);
    }

    #[test]
    fn the_oldest_id_is_evicted_and_the_newest_stays_seen() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let batch = events(0..MAX_SEEN_IDS);
        let newest = events(MAX_SEEN_IDS..MAX_SEEN_IDS + 1);

        assert_eq!(
            store.commit(key(1), cursor(), &batch).unwrap(),
            MAX_SEEN_IDS
        );
        assert_eq!(store.commit(key(1), cursor(), &newest).unwrap(), 1);
        assert_eq!(
            (
                store.is_seen(&key(1), batch[0].id()),
                store.is_seen(&key(1), batch[1].id()),
                store.is_seen(&key(1), newest[0].id()),
            ),
            (false, true, true)
        );
    }

    #[test]
    fn a_repeated_id_is_refreshed() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let batch = events(0..3);
        let repeat = [batch[0].clone(), batch[0].clone()];
        let newest = events(3..MAX_SEEN_IDS + 1);

        assert_eq!(store.commit(key(1), cursor(), &batch).unwrap(), 3);
        assert_eq!(store.commit(key(1), cursor(), &repeat).unwrap(), 0);
        assert_eq!(
            store.commit(key(1), cursor(), &newest).unwrap(),
            MAX_SEEN_IDS - 2
        );
        assert_eq!(
            (
                store.is_seen(&key(1), batch[0].id()),
                store.is_seen(&key(1), batch[1].id()),
            ),
            (true, false)
        );
    }

    #[test]
    fn opening_removes_only_matching_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("positions.json.1.1.tmp");
        let second = dir.path().join("positions.json.1.2.tmp");
        let unrelated = dir.path().join("other.tmp");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        let _store = Store::open(dir.path()).unwrap();

        assert_missing(&first);
        assert_missing(&second);
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
    }

    #[test]
    fn opening_keeps_user_files_and_directories_with_temp_like_names() {
        let dir = tempfile::tempdir().unwrap();
        let generated = dir.path().join("positions.json.1.2.tmp");
        let notes = dir.path().join("positions.json.notes.tmp");
        let one_number = dir.path().join("positions.json.1.tmp");
        let folder = dir.path().join("positions.json.3.4.tmp");
        fs::write(&generated, b"stale").unwrap();
        fs::write(&notes, b"notes").unwrap();
        fs::write(&one_number, b"one").unwrap();
        fs::create_dir(&folder).unwrap();

        let _store = Store::open(dir.path()).unwrap();

        assert_missing(&generated);
        assert_eq!(fs::read(&notes).unwrap(), b"notes");
        assert_eq!(fs::read(&one_number).unwrap(), b"one");
        assert!(fs::metadata(&folder).unwrap().is_dir());
    }

    #[test]
    fn each_open_removes_at_most_the_temp_file_limit() {
        let dir = tempfile::tempdir().unwrap();
        let count_temp_files = || {
            fs::read_dir(dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .filter(|name| is_generated_temp_name(&name.to_string_lossy()))
                .count()
        };

        for index in 0..150 {
            let name = format!("positions.json.9.{index}.tmp");
            fs::write(dir.path().join(name), b"stale").unwrap();
        }

        drop(Store::open(dir.path()).unwrap());

        assert_eq!(count_temp_files(), 50);

        drop(Store::open(dir.path()).unwrap());

        assert_eq!(count_temp_files(), 0);
    }

    fn scan_paths(dir: &Path, generated: std::ops::Range<usize>) -> Vec<PathBuf> {
        (0..600)
            .map(|index| {
                if generated.contains(&index) {
                    let path = dir.join(format!("positions.json.7.{index}.tmp"));
                    fs::write(&path, b"stale").unwrap();
                    path
                } else {
                    dir.join(format!("other-{index}.txt"))
                }
            })
            .collect()
    }

    fn existing(paths: &[PathBuf]) -> usize {
        paths.iter().filter(|path| path.exists()).count()
    }

    #[test]
    fn cleanup_never_scans_past_the_scan_limit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scan_paths(dir.path(), 500..550);

        assert_eq!(cleanup_paths(paths.clone().into_iter()), 0);
        assert_eq!(existing(&paths[500..550]), 50);
    }

    #[test]
    fn cleanup_removes_generated_files_within_the_scan_limit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scan_paths(dir.path(), 450..500);

        assert_eq!(cleanup_paths(paths.clone().into_iter()), 50);
        assert_eq!(existing(&paths[450..500]), 0);
    }

    #[test]
    fn cleanup_examines_at_most_the_scan_limit_of_entries() {
        let dir = tempfile::tempdir().unwrap();

        for index in 0..600 {
            fs::write(dir.path().join(format!("other-{index}.txt")), b"").unwrap();
        }

        assert_eq!(cleanup_temp_files(dir.path()), MAX_TEMP_SCAN);
    }

    #[test]
    fn unreadable_entries_count_toward_the_scan_limit() {
        let dir = tempfile::tempdir().unwrap();
        let generated: Vec<_> = (0..10)
            .map(|index| {
                let path = dir.path().join(format!("positions.json.7.{index}.tmp"));
                fs::write(&path, b"stale").unwrap();
                path
            })
            .collect();
        let injected = (0..MAX_TEMP_SCAN).map(|_| Err(io::Error::other("injected")));
        let entries: Vec<io::Result<fs::DirEntry>> =
            injected.chain(fs::read_dir(dir.path()).unwrap()).collect();

        assert_eq!(cleanup_entries(entries.into_iter()), MAX_TEMP_SCAN);
        assert_eq!(existing(&generated), 10);
    }

    #[test]
    fn opening_keeps_generated_files_past_the_scan_limit() {
        let dir = tempfile::tempdir().unwrap();
        let generated: Vec<_> = (0..10)
            .map(|index| {
                let path = dir.path().join(format!("positions.json.7.{index}.tmp"));
                fs::write(&path, b"stale").unwrap();
                path
            })
            .collect();
        let cleanup = |dir: &Path| {
            let injected =
                (0..MAX_TEMP_SCAN).map(|_| Err(io::Error::other("injected")));
            let entries: Vec<io::Result<fs::DirEntry>> =
                injected.chain(fs::read_dir(dir).unwrap()).collect();

            cleanup_entries(entries.into_iter())
        };

        let opened = Store::open_with_cleanup(dir.path(), cleanup)
            .map(drop)
            .map_err(|error| error.to_string());

        assert_eq!(opened, Ok(()));
        assert_eq!(existing(&generated), 10);
    }

    #[test]
    fn opening_a_crowded_directory_removes_at_most_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let generated: Vec<_> = (0..600)
            .map(|index| {
                let path = dir.path().join(format!("positions.json.8.{index}.tmp"));
                fs::write(&path, b"stale").unwrap();
                path
            })
            .collect();

        let opened = Store::open(dir.path()).map(drop).map_err(|e| e.to_string());

        assert_eq!(opened, Ok(()));
        assert_eq!(existing(&generated), 600 - MAX_TEMP_REMOVE);
    }

    #[cfg(unix)]
    #[test]
    fn opening_succeeds_when_cleanup_cannot_remove_a_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store_dir = dir.path().join("store");
        let stale = store_dir.join("positions.json.1.2.tmp");
        fs::create_dir(&store_dir).unwrap();
        fs::write(store_dir.join(LOCK_FILE), b"").unwrap();
        fs::write(&stale, b"stale").unwrap();
        let mode = |bits| fs::Permissions::from_mode(bits);
        fs::set_permissions(&store_dir, mode(0o500)).unwrap();

        let opened = Store::open(&store_dir).map(drop).map_err(|e| e.to_string());
        let kept = fs::read(&stale).map_err(|error| error.kind());
        fs::set_permissions(&store_dir, mode(0o700)).unwrap();

        assert_eq!(opened, Ok(()));
        assert_eq!(kept, Ok(b"stale".to_vec()));
    }

    #[test]
    fn only_generated_temp_names_match() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let path = store.temp_path();
        let generated = path.file_name().unwrap().to_str().unwrap();

        assert!(is_generated_temp_name(generated));
        assert!(is_generated_temp_name("positions.json.123.45.tmp"));
        assert!(is_generated_temp_name("positions.json.1.0.tmp"));
        let longest = format!("positions.json.{}.{}.tmp", u32::MAX, u64::MAX);
        assert!(is_generated_temp_name(&longest));

        let rejected = [
            "positions.json.notes.tmp",
            "positions.json.1.x.tmp",
            "positions.json..2.tmp",
            "positions.json.1..tmp",
            "positions.json.1.tmp",
            "positions.json.1.2.3.tmp",
            "positions.json.1.2.tmp.tmp",
            "other.json.1.2.tmp",
            "positions.lock.1.2.tmp",
            "positions.json.1.2.temp",
            "positions.json.1.2",
            "positions.json.01.2.tmp",
            "positions.json.1.02.tmp",
            "positions.json.1.000.tmp",
            "positions.json.1.123456789012345678901.tmp",
            "positions.json.4294967296.1.tmp",
            "positions.json.0.1.tmp",
            "positions.json.1.18446744073709551616.tmp",
        ];
        let accepted: Vec<_> = rejected
            .into_iter()
            .filter(|name| is_generated_temp_name(name))
            .collect();

        assert_eq!(accepted, Vec::<&str>::new());
    }

    #[test]
    fn the_same_id_from_two_sources_is_seen_independently() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let shared = [event("shared".into())];
        let id = shared[0].id();

        assert_eq!(store.commit(key(1), cursor(), &shared).unwrap(), 1);
        assert_eq!(
            (store.is_seen(&key(1), id), store.is_seen(&key(2), id)),
            (true, false)
        );
        assert_eq!(store.commit(key(2), cursor(), &shared).unwrap(), 1);
        assert_eq!(
            (store.is_seen(&key(1), id), store.is_seen(&key(2), id)),
            (true, true)
        );
    }

    #[test]
    fn an_oversized_batch_is_refused_without_changing_state_or_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(store.commit(key(1), cursor(), &[]).unwrap(), 0);
        let before = store.state.clone();
        let bytes = fs::read(&store.path).unwrap();
        let batch = events(0..MAX_SEEN_IDS + 1);

        let error = store.commit(key(1), cursor(), &batch).unwrap_err();
        let StoreError::TooMany { limit } = error else {
            panic!("expected too many seen ids, got {error:?}");
        };

        assert_eq!(limit, MAX_SEEN_IDS);
        assert_eq!(store.state, before);
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
        assert_no_temp_files(dir.path());
    }

    #[test]
    fn a_full_batch_with_a_repeat_keeps_every_new_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let earlier = events(0..1);
        let fresh = events(1..MAX_SEEN_IDS + 1);
        let batch: Vec<_> = fresh.iter().chain(&earlier).cloned().collect();

        assert_eq!(store.commit(key(1), cursor(), &earlier).unwrap(), 1);
        assert_eq!(
            store.commit(key(1), cursor(), &batch).unwrap(),
            MAX_SEEN_IDS
        );

        // The refreshed repeat is older than every new ID, so a full batch of
        // new IDs pushes it out rather than one of them.
        let expected: VecDeque<_> =
            fresh.iter().map(|event| event.id().clone()).collect();

        assert_eq!(store.state.seen[&key(1)], expected);
    }

    #[test]
    fn an_oversized_batch_with_a_repeat_is_refused_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let earlier = events(0..1);
        assert_eq!(store.commit(key(1), cursor(), &earlier).unwrap(), 1);
        let before = store.state.clone();
        let bytes = fs::read(&store.path).unwrap();
        let batch: Vec<_> = events(1..MAX_SEEN_IDS + 2)
            .into_iter()
            .chain(earlier)
            .collect();

        let error = store.commit(key(1), cursor(), &batch).unwrap_err();
        let StoreError::TooMany { limit } = error else {
            panic!("expected too many seen ids, got {error:?}");
        };

        assert_eq!(limit, MAX_SEEN_IDS);
        assert_eq!(store.state, before);
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
        assert_no_temp_files(dir.path());
    }

    #[test]
    fn malformed_json_is_refused_without_rewriting_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("positions.json");
        fs::write(&path, b"{").unwrap();

        assert_corrupt(dir.path(), &path, "invalid json at line 1 column 1");
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
        let id = state.seen[&key].front().unwrap();

        assert_eq!(
            (store.position(&key), store.is_seen(&key, id)),
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

        assert_eq!(store.position(&key(0)), Some(&cursor()));
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
            seen: BTreeMap::from([(key(0), VecDeque::from([id.clone(), id]))]),
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
        store.state.positions = (0..MAX_POSITIONS)
            .map(|index| (key(index), cursor()))
            .collect();
        let before = store.state.clone();

        let error = store.commit(key(MAX_POSITIONS), cursor(), &[]).unwrap_err();
        let StoreError::TooMany { limit } = error else {
            panic!("expected too many positions, got {error:?}");
        };

        assert_eq!(limit, MAX_POSITIONS);
        assert_eq!(store.state, before);
        assert_missing(&store.path);
        assert_no_temp_files(dir.path());
    }

    #[test]
    fn commit_saves_a_file_that_parses_back_to_the_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let path = dir.path().join("positions.json");
        let batch = events(0..2);

        assert_eq!(store.commit(key(1), cursor(), &batch).unwrap(), 2);
        assert_no_temp_files(dir.path());

        let bytes = fs::read(&path).unwrap();

        assert_ne!(bytes.len(), 0);
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
        drop(store);

        let reopened = Store::open(dir.path()).unwrap();

        assert_eq!(reopened.position(&key), Some(&position));
    }

    #[test]
    fn byte_overflow_leaves_the_previous_state_and_file_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(store.commit(key(1), cursor(), &[]).unwrap(), 0);
        let before = store.state.clone();
        let bytes = fs::read(&store.path).unwrap();

        // The maximum-length IDs expand when their quotes are escaped in JSON.
        let suffix = "\"".repeat(MAX_ID_LEN - 4);
        let events: Vec<_> = (0..MAX_SEEN_IDS)
            .map(|index| event(format!("{index:04}{suffix}")))
            .collect();

        let error = store.commit(key(2), cursor(), &events).unwrap_err();
        let StoreError::TooLarge { limit } = error else {
            panic!("expected state too large, got {error:?}");
        };

        assert_eq!(limit, MAX_STORE_BYTES);
        assert_eq!(store.state, before);
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
        assert_no_temp_files(dir.path());
    }
}
