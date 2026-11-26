//! `sourcefed-core` follows a timer and prints its events as JSON lines.

use std::collections::HashSet;
use std::error::Error;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;

use clap::{Args, Parser, Subcommand};
use sourcefed_core::{
    EngineState, EventId, MonitorConfig, MonitorId, PollEngine, PollInterval,
    Source, StopHandle, Store, SystemClock, TimerSource,
};

// One input line holds a command and an event ID of at most 256 bytes.
const MAX_INPUT_LINE: u64 = 512;
// After detecting an over-long line, read_line discards at most this many
// more bytes before handing off to the reader's interruptible discard.
const MAX_DISCARD_BYTES: u64 = 65_536;
// Check for reader shutdown between chunks without copying discarded bytes.
const DISCARD_CHUNK_BYTES: usize = 512;
// The remainder discard has its own byte budget after read_line's discard.
const MAX_TOTAL_DISCARD_BYTES: usize = 1_048_576;
// At most this many inputs apply between two polls, so a fast writer on stdin
// cannot hold polling back; the rest wait for the next poll. The reader also
// stops if it discards this many over-long lines without sending an input.
const MAX_INPUTS_PER_POLL: usize = 64;
// At most this many inputs wait between the stdin reader and the polls; once
// full, the reader blocks rather than growing memory.
const MAX_QUEUED_INPUTS: usize = 128;

#[derive(Parser)]
#[command(name = "sourcefed-core", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Follows a timer and prints each event as one JSON line. Each poll
    /// reads a bounded number of ack and stop lines from stdin; a line over
    /// 512 bytes is discarded with a diagnostic. If it runs another 65536
    /// bytes without a newline, the reader logs discard-bound-exceeded and
    /// discards the remainder in bounded chunks. A newline before the
    /// remainder discard reaches one mebibyte lets later ack and stop lines
    /// reach the reader unless the discarded-line budget is exhausted. The
    /// byte cap ends stdin reading with discard-total-cap-reached. The
    /// reader also logs discard-line-budget-exhausted and stops after
    /// discarding 64 over-long lines without sending an input. A successful
    /// input send resets the count; an invalid input does not.
    /// An ack sent while sourcefed-core is stopping may be ignored; its event
    /// is delivered again on the next run.
    Follow(Follow),
}

#[derive(Args)]
struct Follow {
    /// The job the timer fires.
    #[arg(long)]
    job: String,
    /// Seconds between firings, from 1 to 3600.
    #[arg(long)]
    every: u64,
    /// The directory that keeps the position and pending events.
    #[arg(long)]
    state_dir: PathBuf,
    /// The most polls this run makes before it exits.
    #[arg(long)]
    max_polls: u32,
}

#[derive(Debug, Eq, PartialEq)]
enum Input {
    Ack(EventId),
    Stop,
}

#[derive(Debug, Eq, PartialEq)]
enum Line {
    Read,
    TooLong,
    Endless,
    End,
}

fn main() -> ExitCode {
    let Command::Follow(args) = Cli::parse().command;

    match follow(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("sourcefed-core: {error}");

            ExitCode::FAILURE
        }
    }
}

fn follow(args: Follow) -> Result<(), Box<dyn Error>> {
    let mut engine = engine(args.job, args.every, &args.state_dir)?;
    let (sender, receiver) = input_channel();
    let stop = engine.handle();
    let reader = Arc::new(ReaderState::default());
    let state = Arc::clone(&reader);
    thread::spawn(move || {
        read_input(io::stdin().lock(), &stop, &state, &sender);
    });

    let mut inputs = Inputs {
        receiver,
        reader,
        stopped: false,
    };
    let mut printed = HashSet::new();

    for _ in 0..args.max_polls {
        inputs.apply(&mut engine)?;
        let state = engine.run(1)?;
        print_new(&engine, &mut printed)?;

        if state != EngineState::Running {
            break;
        }
    }

    inputs.finish(&mut engine)
}

fn engine(
    job: String,
    every: u64,
    state_dir: &Path,
) -> Result<PollEngine, Box<dyn Error>> {
    let source = TimerSource::new(job.clone(), every)?;
    let config = MonitorConfig {
        id: MonitorId::new(job)?,
        source: source.name().clone(),
        poll_interval: PollInterval::from_secs(every)?,
    };
    let store = Store::open(state_dir)?;
    let engine =
        PollEngine::new(config, Arc::new(source), store, Arc::new(SystemClock))?;

    Ok(engine)
}

fn print_new(
    engine: &PollEngine,
    printed: &mut HashSet<EventId>,
) -> Result<(), Box<dyn Error>> {
    let Some(pending) = engine.pending() else {
        return Ok(());
    };

    let mut out = io::stdout().lock();

    for event in pending {
        if printed.insert(event.id().clone()) {
            writeln!(out, "{}", serde_json::to_string(event)?)?;
        }
    }

    out.flush()?;
    // Acknowledged IDs never return, so only pending ones need remembering.
    printed.retain(|id| pending.iter().any(|event| event.id() == id));

    Ok(())
}

fn input_channel() -> (SyncSender<Input>, Receiver<Input>) {
    mpsc::sync_channel(MAX_QUEUED_INPUTS)
}

// The reader locks the handoff slot after reading a complete line and holds
// it through parsing and publication. Shutdown can close the slot first,
// or take the input already being prepared. Neither operation holds the
// lock during stdin reads or channel sends.
#[derive(Debug, Default)]
struct ReaderState {
    phase: AtomicU8,
    held: Mutex<Held>,
    #[cfg(test)]
    hold_gate: Option<tests::HoldGate>,
}

#[derive(Debug)]
enum Held {
    Open(Option<Input>),
    Closed,
}

impl Default for Held {
    fn default() -> Self {
        Self::Open(None)
    }
}

impl ReaderState {
    const READING: u8 = 0;
    const SENDING: u8 = 1;
    const HALTED: u8 = 2;

    // Moves from reading to sending; false once halted.
    fn begin_send(&self) -> bool {
        self.advance(Self::READING, Self::SENDING)
    }

    // Moves from sending back to reading; false once halted.
    fn end_send(&self) -> bool {
        self.advance(Self::SENDING, Self::READING)
    }

    fn advance(&self, from: u8, to: u8) -> bool {
        self.phase
            .compare_exchange(from, to, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn is_halted(&self) -> bool {
        self.phase.load(Ordering::SeqCst) == Self::HALTED
    }

    // Halts the reader and returns whether it was sending, in which case one
    // more input arrives before the reader drops its sender.
    fn halt(&self) -> bool {
        self.phase.swap(Self::HALTED, Ordering::SeqCst) == Self::SENDING
    }

    // Parses and publishes one bounded line as a single handoff. False if
    // finish already closed the slot.
    fn hold(
        &self,
        parse: impl FnOnce() -> Result<Input, String>,
    ) -> Result<bool, String> {
        let mut held = self.lock_held();
        let Held::Open(input) = &mut *held else {
            return Ok(false);
        };

        #[cfg(test)]
        if let Some(gate) = &self.hold_gate {
            gate.wait();
        }

        *input = Some(parse()?);
        drop(held);

        Ok(true)
    }

    // Moves from reading to sending and hands over the held input. None once
    // halted, and the input stays held.
    fn claim(&self) -> Option<Input> {
        if !self.begin_send() {
            return None;
        }

        self.take_held()
    }

    fn take_held(&self) -> Option<Input> {
        match &mut *self.lock_held() {
            Held::Open(input) => input.take(),
            Held::Closed => None,
        }
    }

    fn close_held(&self) -> Option<Input> {
        let held = std::mem::replace(&mut *self.lock_held(), Held::Closed);

        match held {
            Held::Open(input) => input,
            Held::Closed => None,
        }
    }

    // Parsing completes before replacing the slot, so the value under a
    // poisoned lock is still valid and is used as it is.
    fn lock_held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct Inputs {
    receiver: Receiver<Input>,
    reader: Arc<ReaderState>,
    stopped: bool,
}

impl Inputs {
    fn apply(&mut self, engine: &mut PollEngine) -> Result<(), Box<dyn Error>> {
        self.take(engine, MAX_INPUTS_PER_POLL)
    }

    // Applies up to `limit` inputs already queued, without waiting for more.
    fn take(
        &mut self,
        engine: &mut PollEngine,
        limit: usize,
    ) -> Result<(), Box<dyn Error>> {
        for _ in 0..limit {
            let Ok(input) = self.receiver.try_recv() else {
                break;
            };

            self.handle(engine, input)?;
        }

        Ok(())
    }

    // Applies every input the reader queued or held before the run ended, by
    // a stop or the poll limit, so no ack is replayed after a restart. The
    // queue holds at most `MAX_QUEUED_INPUTS`, plus the one a halted reader
    // was already sending. The input it held without claiming is the last it
    // read, so it applies after the queue. Nothing here waits on stdin.
    fn finish(&mut self, engine: &mut PollEngine) -> Result<(), Box<dyn Error>> {
        let limit = MAX_QUEUED_INPUTS.saturating_add(1);

        if self.reader.halt() {
            self.drain(engine, limit)?;
        } else {
            self.take(engine, limit)?;
        }

        if let Some(input) = self.reader.close_held() {
            self.handle(engine, input)?;
        }

        Ok(())
    }

    // Applies up to `limit` inputs, waiting for each, until the reader drops
    // its sender.
    fn drain(
        &mut self,
        engine: &mut PollEngine,
        limit: usize,
    ) -> Result<(), Box<dyn Error>> {
        for _ in 0..limit {
            let Ok(input) = self.receiver.recv() else {
                break;
            };

            self.handle(engine, input)?;
        }

        Ok(())
    }

    fn handle(
        &mut self,
        engine: &mut PollEngine,
        input: Input,
    ) -> Result<(), Box<dyn Error>> {
        match input {
            Input::Ack(id) => {
                let removed = engine.ack(std::slice::from_ref(&id))?;
                eprintln!(
                    "sourcefed-core: ack {}: {removed} event(s) removed",
                    id.as_str()
                );
            }
            Input::Stop => self.stopped = true,
        }

        Ok(())
    }
}

fn read_input(
    mut reader: impl BufRead,
    stop: &StopHandle,
    state: &ReaderState,
    sender: &SyncSender<Input>,
) {
    let mut line = Vec::new();
    let mut discarded_lines = 0_usize;

    while !state.is_halted() {
        match read_line(&mut reader, &mut line) {
            Ok(Line::End) => return,
            Ok(Line::Read) => {}
            Ok(discarded_line @ (Line::TooLong | Line::Endless)) => {
                if discarded_line == Line::Endless {
                    eprintln!(
                        "sourcefed-core: discard-bound-exceeded: input line runs \
                         {MAX_DISCARD_BYTES} bytes past the \
                         {MAX_INPUT_LINE}-byte limit"
                    );

                    if let Err(error) = discard_line_remainder(&mut reader, state) {
                        eprintln!("sourcefed-core: stdin: {error}");

                        return;
                    }
                } else {
                    eprintln!(
                        "sourcefed-core: input line exceeds {MAX_INPUT_LINE} bytes"
                    );
                }

                discarded_lines = discarded_lines.saturating_add(1);

                if discarded_lines == MAX_INPUTS_PER_POLL {
                    eprintln!(
                        "sourcefed-core: discard-line-budget-exhausted: discarded \
                         {MAX_INPUTS_PER_POLL} over-long lines without sending an \
                         input; reading stdin ends"
                    );

                    return;
                }

                continue;
            }
            Err(error) => {
                eprintln!("sourcefed-core: stdin: {error}");

                return;
            }
        }

        match state.hold(|| {
            let text =
                std::str::from_utf8(&line).map_err(|error| error.to_string())?;

            parse_input(text)
        }) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                eprintln!("sourcefed-core: {error}");

                continue;
            }
        }

        if !send_held(stop, state, sender) {
            return;
        }

        discarded_lines = 0;
    }
}

// Sends the input the reader holds. False once reading has to end: the run
// halted the reader, or the polls dropped the receiver.
fn send_held(
    stop: &StopHandle,
    state: &ReaderState,
    sender: &SyncSender<Input>,
) -> bool {
    // A halt that comes after the claim waits for this send; one that came
    // first leaves the input held.
    let Some(input) = state.claim() else {
        return false;
    };
    let stopping = input == Input::Stop;

    if sender.send(input).is_err() {
        return false;
    }

    if stopping {
        stop.stop();
    }

    state.end_send()
}

// Reads one line of at most `MAX_INPUT_LINE` bytes before its newline into
// `line`. A longer line is discarded through its newline or up to the
// discard bound. If it runs past the bound, the caller skips the rest.
fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<Line> {
    line.clear();

    let limit = MAX_INPUT_LINE.saturating_add(1);

    if reader.by_ref().take(limit).read_until(b'\n', line)? == 0 {
        return Ok(Line::End);
    }

    let ended = line.last() == Some(&b'\n');
    let within = u64::try_from(line.len()).is_ok_and(|len| len <= MAX_INPUT_LINE);

    if ended || within {
        return Ok(Line::Read);
    }

    if discard_line(reader, line)? {
        return Ok(Line::TooLong);
    }

    Ok(Line::Endless)
}

// Discards the rest of an over-long line through its newline or the end of
// the input, reading at most `MAX_INPUT_LINE` bytes at a time into `chunk`.
// False once `MAX_DISCARD_BYTES` are read and the line has not ended; no
// byte past those is read.
fn discard_line(reader: &mut impl BufRead, chunk: &mut Vec<u8>) -> io::Result<bool> {
    let mut left = MAX_DISCARD_BYTES;

    while left > 0 {
        chunk.clear();

        let size = left.min(MAX_INPUT_LINE);
        let read = reader.by_ref().take(size).read_until(b'\n', chunk)?;

        if read == 0 || chunk.last() == Some(&b'\n') {
            return Ok(true);
        }

        left = left.saturating_sub(size);
    }

    Ok(false)
}

// Skips an over-long line without copying its tail, checking for shutdown
// between chunks. A newline before the byte cap leaves the next command
// unread; reaching the cap ends stdin reading with an error.
fn discard_line_remainder(
    reader: &mut impl BufRead,
    state: &ReaderState,
) -> io::Result<()> {
    let mut left = MAX_TOTAL_DISCARD_BYTES;

    // Allow one iteration per byte for short reads, but never spin at EOF.
    for _ in 0..MAX_TOTAL_DISCARD_BYTES {
        if state.is_halted() {
            return Ok(());
        }

        let buf = reader.fill_buf()?;
        let size = buf.len().min(DISCARD_CHUNK_BYTES).min(left);

        if size == 0 {
            return Ok(());
        }

        let newline = buf.iter().take(size).position(|&byte| byte == b'\n');
        let consumed = newline.map_or(size, |index| index.saturating_add(1));
        reader.consume(consumed);
        left = left.saturating_sub(consumed);

        if left == 0 {
            break;
        }

        if newline.is_some() {
            return Ok(());
        }
    }

    Err(io::Error::other(
        "discard-total-cap-reached: reading stdin ends",
    ))
}

fn parse_input(line: &str) -> Result<Input, String> {
    let line = line.trim();

    if line == "stop" {
        return Ok(Input::Stop);
    }

    let Some(id) = line.strip_prefix("ack ") else {
        return Err(format!(
            "unknown input {line:?}; use ack <event-id> or stop"
        ));
    };

    EventId::new(id.trim().to_owned())
        .map(Input::Ack)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::TrySendError;
    use std::time::{Duration, Instant};

    use sourcefed_core::{Event, Position, PositionKey, SourceName};

    use super::*;

    const ID: &str = "timer:deploy:2026-01-01T00:00:00Z";
    // Ample for a few hundred inputs, yet a stuck drain or send fails the
    // test rather than hanging it.
    const WAIT: Duration = Duration::from_secs(3);

    fn ack(id: &str) -> Input {
        Input::Ack(EventId::new(id.into()).unwrap())
    }

    fn inputs() -> (SyncSender<Input>, Inputs) {
        let (sender, receiver) = input_channel();

        (
            sender,
            Inputs {
                receiver,
                reader: Arc::new(ReaderState::default()),
                stopped: false,
            },
        )
    }

    fn pending_engine(dir: &Path) -> PollEngine {
        pending_engine_with(dir, &[ID])
    }

    // Saves pending events under the key `follow` uses for job deploy.
    fn pending_engine_with(dir: &Path, ids: &[&str]) -> PollEngine {
        let events: Vec<Event> = ids
            .iter()
            .map(|id| {
                serde_json::from_value(serde_json::json!({
                    "id": id,
                    "kind": "timer.fired",
                    "subject": { "source": "timer", "key": "deploy" },
                    "summary": "timer deploy fired at 2026-01-01T00:00:00Z",
                    "at": "2026-01-01T00:00:00Z",
                }))
                .unwrap()
            })
            .collect();
        let key = PositionKey {
            monitor: MonitorId::new("deploy".into()).unwrap(),
            source: SourceName::new("timer".into()).unwrap(),
        };
        let position = Position::new("2026-01-01T00:00:01Z".into()).unwrap();
        Store::open(dir)
            .unwrap()
            .commit(key, position, &events)
            .unwrap();

        engine("deploy".into(), 1, dir).unwrap()
    }

    // Runs `finish` on its own thread and waits at most `WAIT` for it.
    fn finish_within(
        mut inputs: Inputs,
        mut engine: PollEngine,
    ) -> (Inputs, PollEngine) {
        let (done, finished) = mpsc::channel();

        thread::spawn(move || {
            let result = inputs.finish(&mut engine).map_err(|e| e.to_string());
            done.send((result, inputs, engine)).unwrap();
        });

        let (result, inputs, engine) = finished.recv_timeout(WAIT).unwrap();

        assert_eq!(result, Ok(()));

        (inputs, engine)
    }

    // Waits at most `WAIT` for a phase change, yielding between checks.
    fn reached_within(ready: impl Fn() -> bool) -> bool {
        let started = Instant::now();

        while !ready() {
            if started.elapsed() >= WAIT {
                return false;
            }

            thread::yield_now();
        }

        true
    }

    #[derive(Debug)]
    pub struct HoldGate {
        entered: mpsc::Sender<()>,
        resume: Mutex<Receiver<()>>,
    }

    impl HoldGate {
        pub fn wait(&self) {
            self.entered.send(()).unwrap();
            self.resume.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
    }

    // Serves `lines` and halts the reader as their last byte is read, the
    // way a run ends just after a line reaches the reader.
    struct HaltsWhenRead<'a> {
        lines: &'a [u8],
        state: &'a ReaderState,
    }

    impl HaltsWhenRead<'_> {
        fn halt_at_the_end(&self) {
            if self.lines.is_empty() {
                self.state.halt();
            }
        }
    }

    impl Read for HaltsWhenRead<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let read = self.lines.read(buf)?;
            self.halt_at_the_end();

            Ok(read)
        }
    }

    impl BufRead for HaltsWhenRead<'_> {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            Ok(self.lines)
        }

        fn consume(&mut self, amount: usize) {
            self.lines.consume(amount);
            self.halt_at_the_end();
        }
    }

    fn pending_ids(engine: &PollEngine) -> Vec<&str> {
        engine
            .pending()
            .into_iter()
            .flatten()
            .map(|event| event.id().as_str())
            .collect()
    }

    #[test]
    fn apply_acks_queued_events_and_ignores_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (sender, mut inputs) = inputs();

        sender.send(ack("timer:deploy:other")).unwrap();
        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), [ID]);

        sender.send(ack(ID)).unwrap();
        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(!inputs.stopped);
    }

    #[test]
    fn apply_handles_at_most_the_bound_in_one_call() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (sender, mut inputs) = inputs();

        for index in 0..MAX_INPUTS_PER_POLL {
            let other = format!("timer:deploy:other-{index}");
            sender.send(ack(&other)).unwrap();
        }

        sender.send(ack(ID)).unwrap();
        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), [ID]);

        inputs.apply(&mut engine).unwrap();

        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
    }

    #[test]
    fn finish_applies_acks_ahead_of_a_stop_without_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (sender, inputs) = inputs();
        engine.handle().stop();

        sender.send(ack(ID)).unwrap();
        sender.send(Input::Stop).unwrap();
        let (inputs, engine) = finish_within(inputs, engine);

        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(inputs.stopped);
    }

    #[test]
    fn finish_without_a_stop_request_returns_without_waiting() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (_sender, inputs) = inputs();

        let (inputs, engine) = finish_within(inputs, engine);

        assert_eq!(pending_ids(&engine), [ID]);
        assert!(!inputs.stopped);
    }

    #[test]
    fn finish_applies_a_full_queue_the_reader_left_when_the_run_ends() {
        let dir = tempfile::tempdir().unwrap();
        let count = MAX_QUEUED_INPUTS.saturating_add(MAX_INPUTS_PER_POLL);
        let ids: Vec<String> = (0..count)
            .map(|index| format!("timer:deploy:{index}"))
            .collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut engine = pending_engine_with(dir.path(), &refs);
        let (sender, mut inputs) = inputs();
        let lines: String = ids.iter().flat_map(|id| ["ack ", id, "\n"]).collect();
        let state = Arc::clone(&inputs.reader);
        let (done, read) = mpsc::channel();

        thread::spawn(move || {
            read_input(lines.as_bytes(), &StopHandle::default(), &state, &sender);
            done.send(()).unwrap();
        });

        // Applying all but a queue's worth lets the reader finish and leaves
        // the queue full for `finish`.
        for _ in 0..MAX_INPUTS_PER_POLL {
            let input = inputs.receiver.recv_timeout(WAIT).unwrap();
            inputs.handle(&mut engine, input).unwrap();
        }

        assert_eq!(read.recv_timeout(WAIT), Ok(()));

        let (inputs, engine) = finish_within(inputs, engine);

        assert!(inputs.reader.is_halted());
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(!inputs.stopped);
    }

    #[test]
    fn finish_waits_for_the_input_a_halted_reader_was_sending() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (sender, inputs) = inputs();

        for index in 0..MAX_QUEUED_INPUTS {
            let other = format!("timer:deploy:other-{index}");
            sender.send(ack(&other)).unwrap();
        }

        // The queue is full, so this send blocks until `finish` makes room.
        assert!(inputs.reader.begin_send());
        let (done, sent) = mpsc::channel();

        thread::spawn(move || {
            done.send(sender.send(ack(ID))).unwrap();
        });

        let (inputs, engine) = finish_within(inputs, engine);

        assert_eq!(sent.recv_timeout(WAIT), Ok(Ok(())));
        assert!(inputs.reader.is_halted());
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
    }

    #[test]
    fn finish_applies_an_ack_the_reader_claimed_before_the_halt() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (sender, inputs) = inputs();

        for index in 0..MAX_QUEUED_INPUTS {
            let other = format!("timer:deploy:other-{index}");
            sender.send(ack(&other)).unwrap();
        }

        let state = Arc::clone(&inputs.reader);
        let line = format!("ack {ID}\n");
        let (done, read) = mpsc::channel();

        thread::spawn(move || {
            read_input(line.as_bytes(), &StopHandle::default(), &state, &sender);
            done.send(()).unwrap();
        });

        // The reader claims the line, then blocks on the full queue, so the
        // halt in `finish` comes after the claim and before the send.
        assert!(reached_within(|| {
            inputs.reader.phase.load(Ordering::SeqCst) == ReaderState::SENDING
        }));

        let (inputs, engine) = finish_within(inputs, engine);

        assert_eq!(read.recv_timeout(WAIT), Ok(()));
        assert!(inputs.reader.is_halted());
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
    }

    #[test]
    fn finish_applies_a_line_the_reader_read_just_before_the_halt() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (sender, inputs) = inputs();
        let line = format!("ack {ID}\n");
        let reader = HaltsWhenRead {
            lines: line.as_bytes(),
            state: &inputs.reader,
        };

        // The halt lands after the read and before the claim, so the reader
        // sends nothing and leaves the ack held.
        read_input(reader, &StopHandle::default(), &inputs.reader, &sender);

        assert_eq!(inputs.receiver.try_iter().collect::<Vec<_>>(), []);
        assert_eq!(pending_ids(&engine), [ID]);

        let (inputs, engine) = finish_within(inputs, engine);

        assert!(inputs.reader.is_halted());
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
        assert!(!inputs.stopped);
    }

    #[test]
    fn finish_applies_an_ack_the_reader_is_preparing_at_the_halt() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = pending_engine(dir.path());
        let (sender, mut inputs) = inputs();
        let (entered, holding) = mpsc::channel();
        let (resume, released) = mpsc::channel();
        Arc::get_mut(&mut inputs.reader).unwrap().hold_gate = Some(HoldGate {
            entered,
            resume: Mutex::new(released),
        });
        let state = Arc::clone(&inputs.reader);
        let reader_state = Arc::clone(&state);
        let line = format!("ack {ID}\n");
        let (done, read) = mpsc::channel();

        thread::spawn(move || {
            read_input(
                line.as_bytes(),
                &StopHandle::default(),
                &reader_state,
                &sender,
            );
            done.send(()).unwrap();
        });

        // The reader has read the line but has not published it. Let finish
        // halt the reader before allowing the handoff to complete.
        assert_eq!(holding.recv_timeout(WAIT), Ok(()));
        let (done, finished) = mpsc::channel();

        thread::spawn(move || {
            inputs.finish(&mut engine).unwrap();
            done.send(engine).unwrap();
        });

        assert!(reached_within(|| state.is_halted()));
        resume.send(()).unwrap();

        let engine = finished.recv_timeout(WAIT).unwrap();

        assert_eq!(read.recv_timeout(WAIT), Ok(()));
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
    }

    #[test]
    fn an_unparseable_line_holds_no_claim() {
        let dir = tempfile::tempdir().unwrap();
        let engine = pending_engine(dir.path());
        let (sender, inputs) = inputs();
        let lines = format!("bogus\nack {ID}\n");

        read_input(
            lines.as_bytes(),
            &StopHandle::default(),
            &inputs.reader,
            &sender,
        );
        drop(sender);

        // The reader read to the end and holds no claim, so `finish` has
        // nothing to wait for and applies the ack after the bad line.
        let (inputs, engine) = finish_within(inputs, engine);

        assert!(inputs.reader.is_halted());
        assert_eq!(pending_ids(&engine), Vec::<&str>::new());
    }

    #[test]
    fn reader_state_sends_only_until_halted() {
        let state = ReaderState::default();

        assert!(!state.end_send());
        assert!(state.begin_send());
        assert!(!state.begin_send());
        assert!(state.end_send());
        assert!(!state.is_halted());
        assert!(!state.halt());
        assert!(state.is_halted());
        assert!(!state.begin_send());

        let sending = ReaderState::default();

        assert!(sending.begin_send());
        assert!(sending.halt());
        assert!(!sending.end_send());
        assert!(sending.is_halted());
    }

    #[test]
    fn reader_state_hands_a_held_input_to_one_taker() {
        let state = ReaderState::default();
        assert_eq!(state.hold(|| Ok(ack(ID))), Ok(true));

        assert_eq!(state.claim(), Some(ack(ID)));
        assert_eq!(state.take_held(), None);
        assert!(state.end_send());

        assert_eq!(state.hold(|| Ok(Input::Stop)), Ok(true));

        assert!(!state.halt());
        assert_eq!(state.claim(), None);
        assert_eq!(state.take_held(), Some(Input::Stop));
        assert_eq!(state.take_held(), None);

        assert_eq!(state.close_held(), None);
        assert_eq!(state.hold(|| Ok(ack(ID))), Ok(false));
        assert_eq!(state.take_held(), None);
    }

    #[test]
    fn read_input_reads_and_sends_nothing_once_halted() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let mut lines = &b"ack first\nstop\n"[..];
        state.halt();

        read_input(&mut lines, &stop, &state, &sender);

        assert_eq!(lines, b"ack first\nstop\n");
        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), []);
    }

    #[test]
    fn input_channel_holds_at_most_the_queue_bound() {
        let (sender, _receiver) = input_channel();

        for _ in 0..MAX_QUEUED_INPUTS {
            sender.try_send(Input::Stop).unwrap();
        }

        assert_eq!(
            sender.try_send(Input::Stop),
            Err(TrySendError::Full(Input::Stop))
        );
    }

    #[test]
    fn read_input_flags_a_stop_only_for_a_stop_line() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();

        read_input(&b"ack first\n"[..], &stop, &state, &sender);

        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [ack("first")]);

        read_input(&b"stop\n"[..], &stop, &state, &sender);

        assert!(stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [Input::Stop]);
    }

    #[test]
    fn read_input_discards_an_over_long_line_through_its_newline() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        // Cut at the limit, the tail of this ack line would read as a stop.
        let pad = "x".repeat(limit.saturating_sub("ack ".len()));
        let lines = format!("ack {pad}stop\nack first\n");

        read_input(lines.as_bytes(), &stop, &state, &sender);

        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [ack("first")]);
    }

    #[test]
    fn read_input_discards_an_over_long_line_whole_across_chunks() {
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let first_read = limit.saturating_add(1);

        // Cut after the first read, or after one discarded chunk, the tail
        // of the line would read as a stop.
        for pad in [first_read, first_read.saturating_add(limit)] {
            let stop = StopHandle::default();
            let state = ReaderState::default();
            let (sender, receiver) = input_channel();
            let lines = format!("{}stop\nack first\n", "x".repeat(pad));

            read_input(lines.as_bytes(), &stop, &state, &sender);

            assert!(!stop.is_stopped());
            assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [ack("first")]);
        }
    }

    #[test]
    fn read_input_discards_a_line_that_ends_at_the_discard_bound() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let bound = usize::try_from(MAX_DISCARD_BYTES).unwrap();
        // After the first read of one byte past the limit, the newline is
        // the last byte the bound lets the reader discard.
        let pad = "x".repeat(limit.saturating_add(bound));
        let lines = format!("{pad}\nack first\n");

        read_input(lines.as_bytes(), &stop, &state, &sender);

        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), [ack("first")]);
    }

    #[test]
    fn read_line_stops_at_the_discard_bound_of_an_endless_line() {
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let bound = usize::try_from(MAX_DISCARD_BYTES).unwrap();
        // The first read takes one byte past the limit, and the discard
        // takes the bound; the line runs on by one byte or by many.
        let read = "x".repeat(limit.saturating_add(1).saturating_add(bound));
        let later = "\nstop\nack first\n";

        for unread in [later.to_owned(), format!("{}{later}", "x".repeat(limit))] {
            let lines = format!("{read}{unread}");
            let mut lines = lines.as_bytes();
            let mut line = Vec::new();

            assert_eq!(read_line(&mut lines, &mut line).unwrap(), Line::Endless);
            assert_eq!(lines, unread.as_bytes());
        }
    }

    #[test]
    fn read_input_processes_stop_and_ack_after_the_discard_bound() {
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let bound = usize::try_from(MAX_DISCARD_BYTES).unwrap();
        let pad = "x".repeat(limit.saturating_add(1).saturating_add(bound));

        // The over-long line ends in a fake stop, with or without another
        // full chunk before it. Only the stop on its own line should arrive.
        for extra in [0, DISCARD_CHUNK_BYTES] {
            let stop = StopHandle::default();
            let state = ReaderState::default();
            let (sender, receiver) = input_channel();
            let tail = "x".repeat(extra);
            let lines = format!("{pad}{tail}stop\nstop\nack first\n");

            read_input(lines.as_bytes(), &stop, &state, &sender);

            assert!(stop.is_stopped());
            assert_eq!(
                receiver.try_iter().collect::<Vec<_>>(),
                [Input::Stop, ack("first")]
            );
        }
    }

    #[test]
    fn discard_line_remainder_consumes_bytes_until_eof_without_a_newline() {
        let mut reader = &b"trailing bytes without a newline"[..];
        let state = ReaderState::default();

        discard_line_remainder(&mut reader, &state).unwrap();

        assert_eq!(reader.fill_buf().unwrap(), b"");
    }

    #[test]
    fn read_input_ends_at_the_total_discard_cap() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let bound = usize::try_from(MAX_DISCARD_BYTES).unwrap();
        let cap = limit
            .saturating_add(1)
            .saturating_add(bound)
            .saturating_add(MAX_TOTAL_DISCARD_BYTES);
        let pad = "x".repeat(cap);
        let lines = format!("{pad}x\nstop\nack first\n");
        let mut reader = lines.as_bytes();

        read_input(&mut reader, &stop, &state, &sender);

        assert_eq!(reader, b"x\nstop\nack first\n");
        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), []);
    }

    #[test]
    fn read_input_ends_at_the_discarded_line_budget() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let bound = usize::try_from(MAX_DISCARD_BYTES).unwrap();
        let over = limit.saturating_add(1);
        let line = format!("{}\n", "x".repeat(over));
        let group = line.repeat(MAX_INPUTS_PER_POLL.saturating_sub(1));
        // The last discard also crosses the first discard bound.
        let last = "x".repeat(over.saturating_add(bound));
        let unread = format!("{line}stop\n");
        let lines = format!("{group}{last}\n{unread}");
        let mut reader = lines.as_bytes();

        read_input(&mut reader, &stop, &state, &sender);

        assert_eq!(reader, unread.as_bytes());
        assert!(!stop.is_stopped());
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), []);
    }

    #[test]
    fn read_input_resets_the_discarded_line_budget_after_an_ack() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let line = format!("{}\n", "x".repeat(limit.saturating_add(1)));
        let group = line.repeat(MAX_INPUTS_PER_POLL.saturating_sub(1));
        let lines = format!("{group}ack first\n{group}stop\n");

        read_input(lines.as_bytes(), &stop, &state, &sender);

        assert!(stop.is_stopped());
        assert_eq!(
            receiver.try_iter().collect::<Vec<_>>(),
            [ack("first"), Input::Stop]
        );
    }

    #[test]
    fn read_input_accepts_a_line_of_exactly_the_limit() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let limit = usize::try_from(MAX_INPUT_LINE).unwrap();
        let over = limit.saturating_add(1);

        read_input(
            format!("{:<over$}\n", "stop").as_bytes(),
            &stop,
            &state,
            &sender,
        );

        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), []);

        read_input(
            format!("{:<limit$}\n", "stop").as_bytes(),
            &stop,
            &state,
            &sender,
        );
        read_input(
            format!("{:<limit$}", "stop").as_bytes(),
            &stop,
            &state,
            &sender,
        );

        assert_eq!(
            receiver.try_iter().collect::<Vec<_>>(),
            [Input::Stop, Input::Stop]
        );
    }

    #[test]
    fn parse_input_reads_ack_and_stop_lines() {
        let id = EventId::new("timer:deploy:2026-01-01T00:00:00Z".into());

        assert_eq!(parse_input("stop\n"), Ok(Input::Stop));
        assert_eq!(
            parse_input("ack timer:deploy:2026-01-01T00:00:00Z\n"),
            Ok(Input::Ack(id.unwrap()))
        );
    }

    #[test]
    fn parse_input_rejects_other_lines() {
        assert_eq!(
            parse_input("halt\n"),
            Err(r#"unknown input "halt"; use ack <event-id> or stop"#.into())
        );
        assert_eq!(
            parse_input("ack  \n"),
            Err("unknown input \"ack\"; use ack <event-id> or stop".into())
        );
    }

    #[test]
    fn read_input_sends_inputs_in_order_and_flags_a_stop() {
        let stop = StopHandle::default();
        let state = ReaderState::default();
        let (sender, receiver) = input_channel();
        let lines = "ack first\nbogus\nstop\nack later\n";

        read_input(lines.as_bytes(), &stop, &state, &sender);
        drop(sender);

        let ack = |id: &str| Input::Ack(EventId::new(id.into()).unwrap());

        assert!(stop.is_stopped());
        assert_eq!(
            receiver.iter().collect::<Vec<_>>(),
            [ack("first"), Input::Stop, ack("later")]
        );
    }
}
