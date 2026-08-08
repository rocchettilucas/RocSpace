//! The RocPlan board file — schema, atomic read/write, and the tolerance rules
//! for reading a file two processes and a human all edit.
//!
//! One file per project: `<projectPath>/.rocspace/plan.json`, holding
//!
//! ```json
//! { "version": 1, "tasks": [ … ] }
//! ```
//!
//! Two things write it: this application (through `plan_write`) and the
//! `rocspace-mcp` server an agent talks to (through the same functions, from
//! its own process — and there is one of those per Claude pane, so "two" is a
//! floor, not a count). A read never sees half a write, because every write
//! here is temp + fsync + rename, the same discipline `sessions` uses. And no
//! write lands on top of one that started after it read, because every
//! read-modify-write takes an advisory lock beside the file first — see
//! `PlanLock` for why last-writer-wins was not good enough.
//!
//! Reading is deliberately forgiving. The file is checked into the user's repo,
//! so it gets hand-edited, merged, and rebased: unknown keys are ignored rather
//! than rejected, an entry that cannot be understood is skipped and counted
//! rather than failing the whole board, and a file that is missing entirely is
//! an empty board rather than an error. The one case that DOES fail is a file
//! that is not parseable JSON at all — answering "no tasks" there would invite
//! the next write to overwrite a file the user could still have recovered.
//!
//! Writing is forgiving in the way that makes reading forgiving worth anything:
//! it puts back what it could not read. A write is not "serialize the cards and
//! truncate" but read-modify-write over the file that is there — the root keys
//! this version does not model, the per-card keys it does not model, and the
//! entries it could not parse at all are all carried forward. Without that,
//! tolerance on the read side is just a slower deletion: RocSpace 1 opens a
//! board RocSpace 2 wrote, ignores the six keys it does not know, and the next
//! save is the moment those keys stop existing. Nothing a user did asked for
//! that, and a git diff of it looks exactly like vandalism.

pub mod watch;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;
use tauri::State;

pub use watch::{RocPlanChangedEvent, RocPlanWatcher, EVENT_ROCPLAN_CHANGED};

/// Directory RocSpace owns inside a project. Same name as the home-directory
/// one (`agents::ROCSPACE_DIR`) on purpose — "RocSpace's stuff lives in
/// `.rocspace`" is one rule wherever you are.
pub const PLAN_DIR: &str = ".rocspace";
/// The board file inside `PLAN_DIR`.
pub const PLAN_FILE: &str = "plan.json";
/// Schema version written into every file. Read tolerates any value (including
/// none): the version is a note for a future migration, not a gate that can
/// lock a user out of their own board.
pub const PLAN_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/// Which column a card sits in. `Cancelled` is a real status rather than a
/// deletion so a card that was dropped keeps its findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RocTaskStatus {
    #[default]
    Todo,
    InProgress,
    InReview,
    Complete,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RocTaskPriority {
    Critical,
    High,
    #[default]
    Medium,
    Low,
}

/// One line of the card's append-only log. `by` is an agent's chat name, `"you"`
/// for the user, or `"mcp:<name>"` when it came in over the MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RocTaskFinding {
    /// Milliseconds since the epoch, like every other timestamp that crosses
    /// the IPC boundary.
    pub at: i64,
    pub by: String,
    pub text: String,
}

/// A card.
///
/// Every field except `id` and `title` has a default, so a hand-written entry
/// with only those two loads as a valid card instead of being dropped. Those
/// two have no sensible default: an entry with no id cannot be addressed by any
/// later update, and one with no title is a blank card the user cannot identify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RocTask {
    /// A ULID, minted by whichever side creates the card (see `new_task_id`).
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: RocTaskStatus,
    #[serde(default)]
    pub priority: RocTaskPriority,
    /// Matches a `TerminalSession.name` in the workspace; `None` = unassigned.
    #[serde(default)]
    pub assigned_terminal_name: Option<String>,
    #[serde(default)]
    pub findings: Vec<RocTaskFinding>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl RocTask {
    /// A fresh `Todo` card with a new id, both timestamps set to now.
    pub fn new(title: impl Into<String>, description: impl Into<String>) -> Self {
        let now = now_ms();
        Self {
            id: new_task_id(),
            title: title.into(),
            description: description.into(),
            status: RocTaskStatus::Todo,
            priority: RocTaskPriority::default(),
            assigned_terminal_name: None,
            findings: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    /// Append a finding and bump `updated_at` — the two always happen together,
    /// because a log line the board does not consider a change would not
    /// re-render the card that got it.
    pub fn push_finding(&mut self, by: impl Into<String>, text: impl Into<String>) {
        self.findings.push(RocTaskFinding {
            at: now_ms(),
            by: by.into(),
            text: text.into(),
        });
        self.updated_at = now_ms();
    }
}

/// The whole file as it is written: the two keys this version owns, then
/// everything that was in the root object before and is none of its business.
///
/// A struct rather than a bare `Map` so `version` and `tasks` keep their place
/// at the top of the file — `serde_json::Map` is a `BTreeMap`, which would sort
/// `tasks` above `version` and rewrite the head of every board in the world
/// once. The flattened remainder lands after them, in its own order.
#[derive(Debug, Serialize)]
struct PlanFile {
    version: u32,
    tasks: Vec<PlanItem>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// One entry of the `tasks` array on the way out.
#[derive(Debug)]
enum PlanItem {
    /// A card, as key/value pairs in the order they should be written.
    ///
    /// A `Vec` and not a `serde_json::Map`, because that is a `BTreeMap`: a
    /// card built as one comes out alphabetically, `assignedTerminalName`
    /// first and `id` fifth, and this file is committed and read in diffs.
    /// The keys `RocTask` declares go first in the order it declares them (see
    /// `TASK_KEYS`), and anything carried forward follows.
    Card(Vec<(String, Value)>),
    /// An entry kept exactly as it was found, whatever shape that is.
    Verbatim(Value),
}

impl Serialize for PlanItem {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Self::Verbatim(value) => value.serialize(serializer),
            Self::Card(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

/// The keys `RocTask` serializes to, in the order it declares them — the order
/// a card is written in. Pinned against the struct by
/// `the_key_order_a_card_is_written_in_is_the_one_the_schema_declares`, so a
/// field added to `RocTask` and not to this list fails a test rather than
/// quietly sorting itself into the tail.
const TASK_KEYS: [&str; 9] = [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "assignedTerminalName",
    "findings",
    "createdAt",
    "updatedAt",
];

/// What a read produced: the cards that were understood, and how many entries
/// were not. `skipped` is surfaced rather than swallowed so a merge conflict
/// that ate three cards is visible instead of silent.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PlanRead {
    pub tasks: Vec<RocTask>,
    pub skipped: usize,
}

/// The board file, split into the part this version of RocSpace understands and
/// the part it merely holds on to.
///
/// This is what makes a write non-destructive: every read that precedes one
/// keeps the original JSON beside the cards, so the write can put back what the
/// schema here has no field for.
#[derive(Debug, Default)]
struct PlanDocument {
    /// The root object with `version` and `tasks` taken out — so, whatever a
    /// newer RocSpace, another tool, or a person left up there.
    root: Map<String, Value>,
    /// Every entry of the `tasks` array, in file order.
    entries: Vec<PlanEntry>,
}

/// One entry of the `tasks` array.
#[derive(Debug)]
enum PlanEntry {
    /// It read as a card. `raw` is the object it read from, kept for the keys
    /// `RocTask` has no field for.
    Task {
        task: RocTask,
        raw: Map<String, Value>,
    },
    /// It did not: no id, an id a card above already used, a field of the wrong
    /// type, or not an object at all. Kept exactly as found — this entry was
    /// never shown to whoever is doing the writing, so nothing they did can
    /// have meant "delete it".
    Unreadable(Value),
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/// Crockford base32 — no I, L, O or U, so an id read off a card and typed back
/// in cannot be mangled by the characters that look like each other.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A ULID: 48 bits of millisecond timestamp then 80 bits of randomness, 26
/// Crockford base32 characters.
///
/// The same id format the renderer mints (`ulid` on npm), because the contract
/// is that either side can create a card and neither can tell which did.
///
/// Sorted lexicographically, ids from different milliseconds are in creation
/// order — that is the timestamp half doing its job, and it is what makes a
/// board merged from two writers still read roughly chronologically. Ids minted
/// inside the SAME millisecond sort by their random half, i.e. arbitrarily:
/// there is no monotonic counter here, and the board does not need one, because
/// it renders cards in file order and only ever uses an id to address a card.
///
/// The randomness comes from `uuid::Uuid::new_v4` — already a dependency, and
/// the platform CSPRNG underneath it — rather than a new crate for 10 bytes.
/// Which bytes matters: a v4 UUID is NOT 128 random bits. Byte 6's high nibble
/// is the version (always `0100`) and byte 8's top two bits are the variant
/// (always `10`), so simply masking off the low 80 bits — bytes 6..16 — would
/// hand six of them to constants and leave 74 bits of entropy behind a fixed
/// pattern that repeats in every id on the board. Bytes 0..6 and 9..13 are
/// random in full, and ten of them is exactly the 80 bits a ULID wants.
pub fn new_task_id() -> String {
    let millis = (now_ms().max(0) as u128) & ((1 << 48) - 1);
    let uuid = *uuid::Uuid::new_v4().as_bytes();
    let mut random: u128 = 0;
    for byte in uuid[0..6].iter().chain(uuid[9..13].iter()) {
        random = (random << 8) | u128::from(*byte);
    }
    let value = (millis << 80) | random;

    let mut out = String::with_capacity(26);
    for position in (0..26).rev() {
        let index = ((value >> (5 * position)) & 31) as usize;
        out.push(CROCKFORD[index] as char);
    }
    out
}

pub fn now_ms() -> i64 {
    use std::time::UNIX_EPOCH;
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// `<project>/.rocspace/plan.json`.
pub fn plan_path(project: &Path) -> PathBuf {
    project.join(PLAN_DIR).join(PLAN_FILE)
}

/// The project directory a caller named, refused unless it is an absolute path.
///
/// Every path in this module is built by joining onto it, and joining onto
/// `Path::new("")` gives `.rocspace/plan.json` — a RELATIVE path, resolved
/// against whatever the process happens to have as its working directory. An
/// empty `projectPath` (a workspace with no directory, a restored session that
/// lost the field, a `custom_args` pane) therefore did not fail: it quietly
/// created a board somewhere else. For the app that is wherever it was
/// launched from; for `rocspace-mcp` it is the agent's own cwd, which is the
/// user's repository — so the agent commits a `.rocspace/plan.json` that
/// nothing on screen can find, in a directory nobody asked about.
///
/// Refused rather than resolved, because there is no correct guess available
/// here. A caller that cannot name a directory has no board.
pub fn project_dir(project_path: &str) -> Result<&Path, String> {
    if project_path.trim().is_empty() {
        return Err("no project directory: a board needs an absolute path".to_string());
    }
    let project = Path::new(project_path);
    if !project.is_absolute() {
        return Err(format!(
            "\"{project_path}\" is not an absolute path: a board needs one, \
             or it lands wherever the process happens to be running"
        ));
    }
    Ok(project)
}

/// Writes in flight, this process. A discriminator, not a count.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A scratch path beside the plan file that no other write will pick.
///
/// Same reasoning as `sessions::temp_path`: a temp name derived from the target
/// alone is the same path for every writer, so two saves in flight have one
/// truncating the file the other is about to rename. Here there are genuinely
/// two writers — this app and the MCP server in its own process — so the pid is
/// doing real work, not guarding against a hypothetical.
fn temp_path(dir: &Path) -> PathBuf {
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{PLAN_FILE}.{}.{seq}.tmp", std::process::id()))
}

// ---------------------------------------------------------------------------
// The write lock
// ---------------------------------------------------------------------------

/// How long a lock may go untouched before the next writer decides its holder
/// is not coming back. The whole operation it guards is a read, a serialize and
/// an fsync of a few kilobytes; ten seconds is orders of magnitude more than
/// that and still short enough that a crashed agent does not wedge the board.
const LOCK_STALE_AFTER: Duration = Duration::from_secs(10);

/// How long a writer waits for the lock before giving up. Deliberately LONGER
/// than `LOCK_STALE_AFTER`: a lock whose holder died is always broken rather
/// than waited out, so this timeout can only ever be reached by genuine
/// contention that is not clearing.
const LOCK_WAIT_LIMIT: Duration = Duration::from_secs(15);

/// The advisory lock every read-modify-write of one board takes.
///
/// Without it, "read the file, change one card, write it back" is a lost
/// update, and the shape of this feature makes that the common case rather than
/// the rare one: four Claude panes in a workspace are four `rocspace-mcp`
/// processes, each told to append a finding to the card it is working. Measured
/// before this existed — four concurrent appends, one landed; forty concurrent
/// appends, three landed — and all forty tool calls reported success, because
/// every one of them did write a whole valid board. The log the contract calls
/// append-only silently was not.
///
/// A lockfile beside `plan.json` rather than a mutex, because the writers are
/// separate processes and a mutex cannot reach across one. `create_new` is the
/// primitive: it either creates the file or tells you somebody else already
/// did, in one atomic step, on every platform this ships to.
///
/// Advisory, not mandatory. A reader never takes it (temp + rename already
/// gives readers a whole file), and neither does a user's editor. What it
/// serializes is exactly the writers that go through this module.
#[derive(Debug)]
struct PlanLock {
    path: PathBuf,
}

impl PlanLock {
    /// Take the lock for `dir`, waiting for whoever has it.
    ///
    /// The failure is reported rather than written through: a save that cannot
    /// get the lock in fifteen seconds is a save that would be clobbering
    /// somebody, and the caller can say so. A lost update cannot be said.
    fn acquire(dir: &Path) -> Result<Self, String> {
        let path = dir.join(format!(".{PLAN_FILE}.lock"));
        let deadline = Instant::now() + LOCK_WAIT_LIMIT;
        // Backoff so forty processes do not spin on one file, with a
        // pid-derived offset so they do not all wake up together. No RNG for
        // it: the pid is already the thing that differs between them.
        let jitter = Duration::from_micros(u64::from(std::process::id() % 997));
        let mut wait = Duration::from_millis(1);
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    // Whose it is, for a human looking at a lock that outlived
                    // the process that took it. Best effort — the lock is the
                    // file existing, not what is in it.
                    let _ = writeln!(file, "{}", std::process::id());
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("lock {}: {e}", path.display())),
            }
            break_if_stale(&path);
            if Instant::now() >= deadline {
                return Err(format!(
                    "{} is still locked by another writer after {}s; nothing was changed",
                    dir.join(PLAN_FILE).display(),
                    LOCK_WAIT_LIMIT.as_secs()
                ));
            }
            std::thread::sleep(wait + jitter);
            wait = (wait * 2).min(Duration::from_millis(25));
        }
    }
}

impl Drop for PlanLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Clear a lock whose holder is not coming back.
///
/// Age rather than liveness: a pid in a file is not portable to check and means
/// nothing across a container or a reboot, whereas "untouched for ten seconds"
/// describes a write that cannot still be in progress.
///
/// Renamed out of the way rather than deleted, because two writers can both
/// decide the same lock is stale at the same moment. Only one `rename` can find
/// the file to move; the loser's fails with "not found" and it goes back to
/// waiting, instead of deleting the fresh lock the winner has meanwhile taken.
fn break_if_stale(path: &Path) {
    let Ok(age) = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .and_then(|at| {
            SystemTime::now()
                .duration_since(at)
                .map_err(|_| std::io::Error::other("a lock from the future"))
        })
    else {
        return;
    };
    if age <= LOCK_STALE_AFTER {
        return;
    }
    let doomed = path.with_extension(format!("stale.{}", std::process::id()));
    if fs::rename(path, &doomed).is_ok() {
        let _ = fs::remove_file(&doomed);
    }
}

/// Read the board, change it, and write it back, with the lock held across all
/// three — the only safe way to make a change that depends on what is already
/// there.
///
/// `change` returning `Err` writes nothing: a tool that cannot find the card it
/// was asked about must not rewrite the file to say so.
///
/// Do not call `write_tasks` (or this) from inside `change`. It would wait on a
/// lock this call is holding, for fifteen seconds, and then fail.
pub fn update_plan<T>(
    project: &Path,
    change: impl FnOnce(&mut Vec<RocTask>) -> Result<T, String>,
) -> Result<T, String> {
    let dir = project.join(PLAN_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _lock = PlanLock::acquire(&dir)?;

    let mut tasks = read_tasks(project)?;
    let outcome = change(&mut tasks)?;
    write_locked(&dir, &tasks)?;
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Change stamps
// ---------------------------------------------------------------------------

/// What the watcher compares between polls: the plan file's modification time,
/// its length, and a hash of its contents. `None` — the whole `Option<Stamp>` —
/// means the file is not there (or cannot be read at all).
///
/// All three, because the first two on their own miss edits this board really
/// makes. Filesystems differ in mtime resolution (nanoseconds on APFS, but one
/// second on some network mounts and on FAT-formatted volumes), and plenty of
/// changes leave the length exactly where it was: `"in_review"` and
/// `"cancelled"` are both nine characters, so is any pair of same-length
/// priorities, so is a typo fixed in a finding. One of those inside one mtime
/// tick was indistinguishable from no change at all, and the board on screen
/// simply never heard that the card had moved.
///
/// So the poll reads the file rather than stat'ing it. That is one read a
/// second per OPEN board, of a file measured in kilobytes, which is cheaper
/// than the class of bug it removes. The hash is `DefaultHasher` — SipHash 1-3
/// with fixed keys, so it is stable for a process's lifetime, which is the only
/// span over which two stamps are ever compared. It is not a checksum anybody
/// stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
    hash: u64,
}

/// The plan file's current stamp, or `None` when it does not exist.
pub fn stamp_of(project: &Path) -> Option<Stamp> {
    stamp_of_file(&plan_path(project))
}

fn stamp_of_file(path: &Path) -> Option<Stamp> {
    // Content first: a file that vanished between the two calls should read as
    // gone, and this way the mtime can only ever be older than the bytes, never
    // newer than them.
    let bytes = fs::read(path).ok()?;
    let modified = fs::metadata(path).ok().and_then(|meta| meta.modified().ok());
    Some(stamp_of_bytes(modified, &bytes))
}

fn stamp_of_bytes(modified: Option<SystemTime>, bytes: &[u8]) -> Stamp {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Stamp {
        modified,
        len: bytes.len() as u64,
        hash: hasher.finish(),
    }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/// Every card in the project's board, plus the count of entries that could not
/// be read. A missing file (or a missing `.rocspace/`) is an empty board.
pub fn read_plan(project: &Path) -> Result<PlanRead, String> {
    let path = plan_path(project);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PlanRead::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    parse_plan(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

/// `read_plan` for callers that only want the cards.
pub fn read_tasks(project: &Path) -> Result<Vec<RocTask>, String> {
    Ok(read_plan(project)?.tasks)
}

/// The board file's text → cards.
///
/// Split out from `read_plan` so the tolerance rules can be tested without a
/// filesystem.
fn parse_plan(raw: &str) -> Result<PlanRead, String> {
    let document = parse_document(raw)?;
    let mut read = PlanRead::default();
    for entry in document.entries {
        match entry {
            PlanEntry::Task { task, .. } => read.tasks.push(task),
            PlanEntry::Unreadable(_) => read.skipped += 1,
        }
    }
    Ok(read)
}

/// The board file's text → every card, plus every byte of it that is not one.
///
/// The one implementation of the tolerance rules; `parse_plan` is this with the
/// preserved half thrown away, and a write is this with the preserved half put
/// back. An empty file parses as an empty board: a zero-byte `plan.json` is
/// what a crashed editor or a `touch` leaves, and refusing to open the board
/// over it would be worse than starting from nothing on a file that holds
/// nothing.
fn parse_document(raw: &str) -> Result<PlanDocument, String> {
    if raw.trim().is_empty() {
        return Ok(PlanDocument::default());
    }
    let value: Value = serde_json::from_str(raw).map_err(|e| format!("not valid JSON: {e}"))?;
    let Value::Object(mut root) = value else {
        return Err("expected a JSON object with a \"tasks\" array".to_string());
    };
    // Removed rather than read: `version` and `tasks` are the two keys a write
    // rewrites, and leaving them in `root` would have them written twice.
    root.remove("version");
    let items = match root.remove("tasks") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("\"tasks\" is not an array".to_string()),
    };

    let mut entries = Vec::with_capacity(items.len());
    let mut seen: HashSet<String> = HashSet::new();
    for item in items {
        // A duplicate id is not a card rather than a second one wearing an id:
        // `plan_update_task_status` and the board both address a card BY id, so
        // a second card wearing one is a card that some updates would silently
        // land on and others would not. First one wins, which on a merge is the
        // one nearer the top — and the loser is kept verbatim rather than
        // deleted, because a merge artefact is the user's to resolve, not ours
        // to quietly discard.
        let is_new_id = item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.trim().is_empty() && seen.insert(id.to_string()));
        let parsed = is_new_id
            .then(|| serde_json::from_value::<RocTask>(item.clone()).ok())
            .flatten();
        entries.push(match (parsed, item) {
            (Some(task), Value::Object(raw)) => PlanEntry::Task { task, raw },
            (_, item) => PlanEntry::Unreadable(item),
        });
    }
    Ok(PlanDocument { root, entries })
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/// Replace the project's board with `tasks`, creating `.rocspace/` if needed.
///
/// Returns the stamp of the file just written — the watcher takes it as its new
/// baseline so this write does not come back as a `rocplan://changed` event
/// (see `watch`). The stamp is read off the TEMP file, after its bytes are on
/// the disk and before the rename publishes them: `rename` does not touch
/// mtime, so it is the same stamp the file ends up with, and taking it here
/// closes the window in which someone else's write could land between our
/// rename and our stat and be adopted as ours.
/// A caller that also has to tell a watcher about this write must hold a
/// `RocPlanWatcher::begin_self_write` guard across the whole call — the stamp
/// alone cannot close the window, because there is no instant at which handing
/// it over is simultaneous with the rename. See `plan_write`.
pub fn write_tasks(project: &Path, tasks: &[RocTask]) -> Result<Stamp, String> {
    let dir = project.join(PLAN_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // Taken even though this write replaces the board wholesale, because the
    // write itself reads (to carry forward what it does not model) and because
    // the read-modify-writers deserve to not be interrupted halfway.
    let _lock = PlanLock::acquire(&dir)?;
    write_locked(&dir, tasks)
}

/// `write_tasks` with the lock already held.
fn write_locked(dir: &Path, tasks: &[RocTask]) -> Result<Stamp, String> {
    let path = dir.join(PLAN_FILE);

    // The file that is there, so the write can put back the parts of it this
    // version does not model. `ok()` and not `?`: a board that is not JSON at
    // all has no structure to preserve, and every path that READS the board
    // refuses it long before it gets here (see `read_plan`), so the only caller
    // that reaches this line over a corrupt file is one that was told to
    // replace it.
    let existing = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| parse_document(&raw).ok());
    let bytes = compose_plan(existing, tasks)?;

    let temp = temp_path(dir);
    let stamp = match write_durably(&temp, &bytes) {
        Ok(stamp) => stamp,
        Err(e) => {
            let _ = fs::remove_file(&temp);
            return Err(format!("write {}: {e}", temp.display()));
        }
    };
    if let Err(e) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("rename into {}: {e}", path.display()));
    }
    // Best effort, like `sessions`: not every platform lets a directory be
    // opened, and a write that reached the file but not its parent's metadata
    // is still a write.
    let _ = fs::File::open(dir).and_then(|handle| handle.sync_all());
    Ok(stamp)
}

/// The bytes of a board holding `tasks`, with everything `existing` had that
/// this version of RocSpace does not own carried forward into it.
///
/// Three kinds of thing survive a write they were never part of:
///
/// - root keys other than `version` and `tasks`;
/// - keys on a card that `RocTask` has no field for, matched to the card by id;
/// - entries the parser could not read at all, back at the index they were
///   found at.
///
/// What does NOT survive is a card the caller dropped. That is the whole point
/// of the id match: `tasks` is authoritative about which cards exist, and only
/// about the fields it declares.
fn compose_plan(existing: Option<PlanDocument>, tasks: &[RocTask]) -> Result<Vec<u8>, String> {
    let PlanDocument { root, entries } = existing.unwrap_or_default();

    let previous: HashMap<&str, &Map<String, Value>> = entries
        .iter()
        .filter_map(|entry| match entry {
            PlanEntry::Task { task, raw } => Some((task.id.as_str(), raw)),
            PlanEntry::Unreadable(_) => None,
        })
        .collect();

    let mut items: Vec<PlanItem> = Vec::with_capacity(tasks.len());
    for task in tasks {
        let value = serde_json::to_value(task).map_err(|e| format!("serialize: {e}"))?;
        let Value::Object(mut object) = value else {
            return Err("a card did not serialize to an object".to_string());
        };
        if let Some(previous) = previous.get(task.id.as_str()) {
            carry_forward(&mut object, previous);
        }
        items.push(PlanItem::Card(in_schema_order(object)));
    }

    // Back where they were. Ascending, so each insertion is into an array that
    // already has every earlier one in place; clamped, because the caller may
    // have written fewer cards than the file had entries.
    for (index, entry) in entries.iter().enumerate() {
        if let PlanEntry::Unreadable(value) = entry {
            items.insert(index.min(items.len()), PlanItem::Verbatim(value.clone()));
        }
    }

    // Pretty, with a trailing newline: this file is committed to the user's
    // repository and read in diffs, and one line per key is the difference
    // between a reviewable change and a wall.
    let mut bytes = serde_json::to_vec_pretty(&PlanFile {
        version: PLAN_VERSION,
        tasks: items,
        extra: root,
    })
    .map_err(|e| format!("serialize: {e}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// A card's keys, `TASK_KEYS` first and everything carried forward after.
fn in_schema_order(mut object: Map<String, Value>) -> Vec<(String, Value)> {
    let mut ordered = Vec::with_capacity(object.len());
    for key in TASK_KEYS {
        if let Some(value) = object.remove(key) {
            ordered.push((key.to_string(), value));
        }
    }
    ordered.extend(object);
    ordered
}

/// Copy into `object` every key `previous` has and it does not.
fn carry_forward(object: &mut Map<String, Value>, previous: &Map<String, Value>) {
    carry_forward_findings(object, previous);
    for (key, value) in previous {
        if !object.contains_key(key) {
            object.insert(key.clone(), value.clone());
        }
    }
}

/// The same, one level down, for the append-only log.
///
/// `findings` is a key `RocTask` DOES model, so the serialized value replaces
/// the old one wholesale and anything a newer RocSpace put inside a log line
/// would go with it. The log is the part of a card least replaceable by hand,
/// so it gets matched too: by position, because findings are appended and never
/// reordered, and only when `at`, `by` and `text` all still agree — so a log
/// somebody DID edit by hand never has one line's unknown keys grafted onto
/// another's.
fn carry_forward_findings(object: &mut Map<String, Value>, previous: &Map<String, Value>) {
    let Some(Value::Array(before)) = previous.get("findings") else {
        return;
    };
    let Some(Value::Array(after)) = object.get_mut("findings") else {
        return;
    };
    for (new, old) in after.iter_mut().zip(before) {
        let (Some(new), Some(old)) = (new.as_object_mut(), old.as_object()) else {
            continue;
        };
        if ["at", "by", "text"].iter().any(|k| new.get(*k) != old.get(*k)) {
            continue;
        }
        for (key, value) in old {
            if !new.contains_key(key) {
                new.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Write `bytes` to `path`, wait for the disk to say so, and report the stamp
/// the file ended up with.
///
/// `sync_all` is the difference between "the file exists" and "the file has our
/// bytes in it after a power cut" — without it the rename can reach the disk
/// while the content it names is still in the page cache, which is exactly the
/// half-written file temp-plus-rename exists to prevent.
fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<Stamp> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    let meta = file.metadata()?;
    // Hashed from the bytes in hand rather than by reading the file back: they
    // are the same bytes, and a re-read here would be the one place a stamp
    // could disagree with what was written.
    Ok(stamp_of_bytes(meta.modified().ok(), bytes))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// All four are `async` for the reason the git and session commands are: a
// synchronous Tauri command runs on the MAIN thread, and every one of these
// ends in a filesystem call. On a stalled volume that is a frozen window, not a
// slow board.
//
// `plan_write`, `plan_watch` and `plan_unwatch` borrow state, and Tauri
// requires an async command with a borrowed argument to return a `Result`.
//
// All four run `project_dir` first, including the two that would otherwise
// never fail. A `projectPath` that is empty or relative is a caller bug, and
// letting `plan_watch` accept one only to have `plan_read` refuse it would put
// the board in a state where it is following a file it can never open.

/// Every card in the project's board. A project with no `.rocspace/plan.json`
/// answers with an empty board rather than an error — that is the state every
/// project starts in.
#[tauri::command]
#[specta::specta]
pub async fn plan_read(project_path: String) -> Result<Vec<RocTask>, String> {
    read_tasks(project_dir(&project_path)?)
}

/// Replace the project's board. Creates `.rocspace/`; the write is atomic.
///
/// Takes the watcher so the write can be recorded as ours. Without that, the
/// next poll sees the file move and tells the renderer to reload the board it
/// just wrote — an echo after every debounced save, and one that lands in the
/// middle of whatever the user is doing next.
#[tauri::command]
#[specta::specta]
pub async fn plan_write(
    state: State<'_, RocPlanWatcher>,
    project_path: String,
    tasks: Vec<RocTask>,
) -> Result<(), String> {
    let project = project_dir(&project_path)?;
    // Held across the whole write, not just reported after it. The stamp alone
    // could never close the window: `rename` publishes the file, and until the
    // watcher is told, a poll in between reports the save as somebody else's
    // change. Handing the stamp over BEFORE the rename does not help either —
    // it just moves the window, to one where the baseline is ahead of the file.
    // The guard makes the whole span invisible to the poll instead, and is
    // dropped after the stamp has landed.
    let writing = state.begin_self_write(project);
    let stamp = write_tasks(project, &tasks)?;
    state.note_self_write(project, stamp);
    drop(writing);
    Ok(())
}

/// Follow the project's board file, emitting `rocplan://changed` when anyone
/// else writes it. Reference-counted: several callers may watch one project and
/// the last one out stops the polling.
#[tauri::command]
#[specta::specta]
pub async fn plan_watch(
    state: State<'_, RocPlanWatcher>,
    project_path: String,
) -> Result<(), String> {
    project_dir(&project_path)?;
    state.watch(&project_path);
    Ok(())
}

/// Drop one caller's interest in a project's board. Takes the same
/// `project_path` string that was passed to `plan_watch` — that string is what
/// the events are labelled with, and re-deriving it is not something the caller
/// should have to do.
#[tauri::command]
#[specta::specta]
pub async fn plan_unwatch(
    state: State<'_, RocPlanWatcher>,
    project_path: String,
) -> Result<(), String> {
    project_dir(&project_path)?;
    state.unwatch(&project_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task(id: &str, title: &str) -> RocTask {
        RocTask {
            id: id.to_string(),
            title: title.to_string(),
            description: String::new(),
            status: RocTaskStatus::Todo,
            priority: RocTaskPriority::Medium,
            assigned_terminal_name: None,
            findings: Vec::new(),
            created_at: 1,
            updated_at: 1,
        }
    }

    // -- The wire shape ----------------------------------------------------
    //
    // These names are the contract with `src/lib/bindings.ts` and with the MCP
    // tools. A rename here is a rename there.

    #[test]
    fn a_task_serializes_with_camel_case_keys_and_snake_case_enums() {
        let mut t = task("01ABC", "Ship it");
        t.status = RocTaskStatus::InReview;
        t.priority = RocTaskPriority::Critical;
        t.assigned_terminal_name = Some("Claude 1".to_string());
        t.findings.push(RocTaskFinding {
            at: 42,
            by: "mcp:claude".to_string(),
            text: "looked".to_string(),
        });

        let value = serde_json::to_value(&t).expect("serializes");

        assert_eq!(value["id"], "01ABC");
        assert_eq!(value["status"], "in_review");
        assert_eq!(value["priority"], "critical");
        assert_eq!(value["assignedTerminalName"], "Claude 1");
        assert_eq!(value["findings"][0]["by"], "mcp:claude");
        assert_eq!(value["createdAt"], 1);
        assert_eq!(value["updatedAt"], 1);
    }

    #[test]
    fn every_status_and_priority_has_the_spelling_the_frontend_uses() {
        let statuses = [
            (RocTaskStatus::Todo, "todo"),
            (RocTaskStatus::InProgress, "in_progress"),
            (RocTaskStatus::InReview, "in_review"),
            (RocTaskStatus::Complete, "complete"),
            (RocTaskStatus::Cancelled, "cancelled"),
        ];
        for (status, name) in statuses {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<RocTaskStatus>(json!(name)).unwrap(),
                status
            );
        }
        let priorities = [
            (RocTaskPriority::Critical, "critical"),
            (RocTaskPriority::High, "high"),
            (RocTaskPriority::Medium, "medium"),
            (RocTaskPriority::Low, "low"),
        ];
        for (priority, name) in priorities {
            assert_eq!(serde_json::to_value(priority).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<RocTaskPriority>(json!(name)).unwrap(),
                priority
            );
        }
    }

    #[test]
    fn an_unassigned_task_serializes_the_name_as_null() {
        // Not omitted: the frontend's type says `string | null`, and a missing
        // key would arrive as `undefined` instead.
        let value = serde_json::to_value(task("a", "t")).unwrap();
        assert_eq!(value["assignedTerminalName"], Value::Null);
    }

    // -- Ids ---------------------------------------------------------------

    #[test]
    fn a_new_id_is_a_26_character_crockford_ulid() {
        let id = new_task_id();
        assert_eq!(id.len(), 26, "{id}");
        assert!(
            id.bytes().all(|b| CROCKFORD.contains(&b)),
            "{id} is not Crockford base32"
        );
    }

    #[test]
    fn ids_are_unique_and_their_timestamp_half_never_goes_backwards() {
        let ids: Vec<String> = (0..500).map(|_| new_task_id()).collect();
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "ids collided");

        // The timestamp half is the leading 10 characters; ids minted later
        // never sort before ids minted earlier. Within one millisecond the
        // order is the random half's, which is arbitrary — there is no
        // monotonic counter and the board does not rely on one.
        let stamps: Vec<&str> = ids.iter().map(|id| &id[..10]).collect();
        assert!(stamps.windows(2).all(|w| w[0] <= w[1]), "{stamps:?}");
    }

    /// A ULID's 128 bits, decoded back out of its Crockford characters.
    fn decode_ulid(id: &str) -> u128 {
        id.bytes().fold(0u128, |acc, b| {
            let index = CROCKFORD
                .iter()
                .position(|c| *c == b)
                .unwrap_or_else(|| panic!("{id} is not Crockford base32"));
            (acc << 5) | index as u128
        })
    }

    #[test]
    fn every_bit_of_the_random_half_is_actually_random() {
        // The bug this pins: the randomness used to be a v4 UUID's low 80 bits,
        // which is bytes 6..16 — and a v4 UUID's byte 6 carries the version
        // nibble and byte 8 the variant bits. Six of the eighty were constants
        // in every id the board ever minted, in the same positions every time.
        let ids: Vec<u128> = (0..200).map(|_| decode_ulid(&new_task_id())).collect();

        for bit in 0..80 {
            let mask = 1u128 << bit;
            assert!(
                ids.iter().any(|v| v & mask != 0),
                "bit {bit} of the random half is always 0"
            );
            assert!(
                ids.iter().any(|v| v & mask == 0),
                "bit {bit} of the random half is always 1"
            );
        }
    }

    #[test]
    fn the_timestamp_half_is_the_clock_and_nothing_else() {
        let before = now_ms() as u128;
        let value = decode_ulid(&new_task_id());
        let after = now_ms() as u128;

        let millis = value >> 80;
        assert!(
            (before..=after).contains(&millis),
            "{millis} is not between {before} and {after}"
        );
    }

    // -- Reading -----------------------------------------------------------

    #[test]
    fn a_project_with_no_plan_file_has_an_empty_board() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_plan(tmp.path()).expect("read"), PlanRead::default());
        // …and one whose `.rocspace/` exists but is empty.
        fs::create_dir_all(tmp.path().join(PLAN_DIR)).unwrap();
        assert_eq!(read_tasks(tmp.path()).expect("read"), vec![]);
    }

    #[test]
    fn a_written_board_reads_back_unchanged() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut first = task("01A", "First");
        first.status = RocTaskStatus::InProgress;
        first.priority = RocTaskPriority::High;
        first.assigned_terminal_name = Some("Claude 1".to_string());
        first.push_finding("you", "kicked off");
        let tasks = vec![first, task("01B", "Second")];

        write_tasks(tmp.path(), &tasks).expect("written");

        assert_eq!(read_tasks(tmp.path()).expect("read"), tasks);
    }

    #[test]
    fn the_file_on_disk_carries_the_schema_version() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_tasks(tmp.path(), &[task("01A", "First")]).expect("written");

        let raw = fs::read_to_string(plan_path(tmp.path())).expect("read");
        let value: Value = serde_json::from_str(&raw).expect("valid JSON");

        assert_eq!(value["version"], PLAN_VERSION);
        assert_eq!(value["tasks"][0]["id"], "01A");
        // Committed to a repository, so it is written for a diff.
        assert!(raw.contains('\n'), "written pretty");
        assert!(raw.ends_with('\n'), "ends with a newline");
    }

    // -- What counts as a project ------------------------------------------

    #[test]
    fn an_empty_or_relative_project_path_is_refused() {
        // `Path::new("").join(".rocspace")` is a RELATIVE path, so an empty
        // `projectPath` did not fail — it wrote a board into whatever the
        // process's working directory happened to be. For `rocspace-mcp` that
        // is the agent's cwd, i.e. the user's repository: a `.rocspace/` in a
        // directory nobody asked about, committed with the work, invisible to
        // the board on screen.
        for refused in ["", "   ", ".", "proj", "./proj", "../proj", ".rocspace"] {
            let err = project_dir(refused).expect_err("{refused:?} was accepted");
            assert!(
                err.contains("absolute") || err.contains("no project directory"),
                "{refused:?}: {err}"
            );
        }
        assert_eq!(
            project_dir("/Users/roc/proj"),
            Ok(Path::new("/Users/roc/proj"))
        );
    }

    #[test]
    fn an_empty_project_path_never_reaches_the_working_directory() {
        // Belt and braces on the above: the guard is worth nothing if a caller
        // can still get to `write_tasks`.
        let tmp = tempfile::tempdir().expect("tempdir");
        let previous = std::env::current_dir().expect("cwd");
        // `set_current_dir` is process-wide, so this test must put it back
        // whatever happens — hence no assertion between the two calls.
        std::env::set_current_dir(tmp.path()).expect("cd");
        let refused = project_dir("");
        std::env::set_current_dir(previous).expect("cd back");

        assert!(refused.is_err());
        assert!(!tmp.path().join(PLAN_DIR).exists());
    }

    #[test]
    fn the_plan_file_sits_in_the_projects_rocspace_directory() {
        let path = plan_path(Path::new("/Users/roc/proj"));
        assert!(
            path.ends_with(PathBuf::from(PLAN_DIR).join(PLAN_FILE)),
            "{path:?}"
        );
    }

    // -- Tolerance ---------------------------------------------------------
    //
    // The file is checked in, so it gets hand-edited, merged and rebased. One
    // bad entry must not take the board down with it.

    #[test]
    fn unknown_keys_are_ignored_rather_than_rejected() {
        let read = parse_plan(
            &json!({
                "version": 99,
                "generatedBy": "some other tool",
                "tasks": [ { "id": "a", "title": "T", "epic": "future-field" } ],
            })
            .to_string(),
        )
        .expect("parsed");

        assert_eq!(read.tasks.len(), 1);
        assert_eq!(read.skipped, 0);
    }

    #[test]
    fn an_entry_with_only_an_id_and_a_title_gets_the_defaults() {
        let read = parse_plan(&json!({ "tasks": [ { "id": "a", "title": "T" } ] }).to_string())
            .expect("parsed");

        let t = &read.tasks[0];
        assert_eq!(t.status, RocTaskStatus::Todo);
        assert_eq!(t.priority, RocTaskPriority::Medium);
        assert_eq!(t.description, "");
        assert_eq!(t.assigned_terminal_name, None);
        assert!(t.findings.is_empty());
    }

    #[test]
    fn unreadable_entries_are_skipped_and_counted_and_the_rest_survive() {
        let read = parse_plan(
            &json!({
                "tasks": [
                    { "id": "keep-1", "title": "Fine" },
                    { "title": "No id at all" },
                    { "id": "   ", "title": "Blank id" },
                    { "id": "bad-status", "title": "T", "status": "half_done" },
                    { "id": "bad-type", "title": 7 },
                    "not even an object",
                    { "id": "keep-2", "title": "Also fine" },
                ],
            })
            .to_string(),
        )
        .expect("parsed");

        let ids: Vec<&str> = read.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["keep-1", "keep-2"]);
        assert_eq!(read.skipped, 5);
    }

    #[test]
    fn a_duplicate_id_is_skipped_so_updates_cannot_land_on_two_cards() {
        let read = parse_plan(
            &json!({
                "tasks": [
                    { "id": "same", "title": "The one that wins" },
                    { "id": "same", "title": "The merge artefact" },
                ],
            })
            .to_string(),
        )
        .expect("parsed");

        assert_eq!(read.tasks.len(), 1);
        assert_eq!(read.tasks[0].title, "The one that wins");
        assert_eq!(read.skipped, 1);
    }

    // -- Preservation ------------------------------------------------------
    //
    // Tolerance on the read side is only worth something if the write side
    // gives back what it could not read. Otherwise RocSpace 1 opening a board
    // RocSpace 2 wrote is a deletion on a delay.

    /// The board file after `tasks` have been written over `before`.
    fn rewritten(before: &str, tasks: &[RocTask]) -> Value {
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(tmp.path().join(PLAN_DIR)).unwrap();
        fs::write(plan_path(tmp.path()), before).unwrap();

        write_tasks(tmp.path(), tasks).expect("written");

        let raw = fs::read_to_string(plan_path(tmp.path())).expect("read");
        serde_json::from_str(&raw).expect("valid JSON")
    }

    #[test]
    fn a_root_key_this_version_does_not_know_survives_a_write() {
        let before = json!({
            "version": 2,
            "generatedBy": "RocSpace 2",
            "columns": [{ "id": "blocked", "title": "Blocked" }],
            "tasks": [ { "id": "a", "title": "T" } ],
        })
        .to_string();

        let after = rewritten(&before, &[task("a", "T")]);

        assert_eq!(after["generatedBy"], "RocSpace 2");
        assert_eq!(after["columns"][0]["id"], "blocked");
        // …and the keys this version DOES own are the ones it wrote, at the top
        // of the file where a diff can find them.
        assert_eq!(after["version"], PLAN_VERSION);
        assert_eq!(after["tasks"][0]["id"], "a");
    }

    #[test]
    fn a_card_key_this_version_does_not_know_survives_a_write() {
        let before = json!({
            "tasks": [
                { "id": "a", "title": "T", "epic": "phase-4", "blockedBy": ["b"] },
                { "id": "b", "title": "U" },
            ],
        })
        .to_string();

        // The card comes back through the caller having lost `epic` entirely —
        // which is exactly what happens when the board round-trips through a
        // renderer whose type does not have the field.
        let mut moved = task("a", "T");
        moved.status = RocTaskStatus::Complete;
        let after = rewritten(&before, &[moved, task("b", "U")]);

        assert_eq!(after["tasks"][0]["epic"], "phase-4");
        assert_eq!(after["tasks"][0]["blockedBy"], json!(["b"]));
        assert_eq!(after["tasks"][0]["status"], "complete", "our write wins");
        assert_eq!(after["tasks"][1]["id"], "b");
    }

    #[test]
    fn a_key_inside_a_finding_survives_a_write() {
        // `findings` is a key `RocTask` models, so the serialized array
        // replaces the old one outright — and the log is the part of a card
        // nobody can retype.
        let before = json!({
            "tasks": [ { "id": "a", "title": "T", "findings": [
                { "at": 1, "by": "mcp:claude", "text": "one", "commit": "abc123" },
                { "at": 2, "by": "you", "text": "two" },
            ] } ],
        })
        .to_string();

        let mut t = task("a", "T");
        t.findings = vec![
            RocTaskFinding {
                at: 1,
                by: "mcp:claude".to_string(),
                text: "one".to_string(),
            },
            RocTaskFinding {
                at: 2,
                by: "you".to_string(),
                text: "two".to_string(),
            },
            RocTaskFinding {
                at: 3,
                by: "you".to_string(),
                text: "three".to_string(),
            },
        ];
        let after = rewritten(&before, &[t]);

        let findings = &after["tasks"][0]["findings"];
        assert_eq!(findings[0]["commit"], "abc123");
        assert_eq!(findings[2]["text"], "three", "the new line is still there");
    }

    #[test]
    fn a_findings_unknown_key_is_not_grafted_onto_a_different_line() {
        // Position alone would move `commit` onto whatever ended up first.
        let before = json!({
            "tasks": [ { "id": "a", "title": "T", "findings": [
                { "at": 1, "by": "you", "text": "one", "commit": "abc123" },
            ] } ],
        })
        .to_string();

        let mut t = task("a", "T");
        t.findings = vec![RocTaskFinding {
            at: 9,
            by: "you".to_string(),
            text: "somebody rewrote the log".to_string(),
        }];
        let after = rewritten(&before, &[t]);

        assert_eq!(after["tasks"][0]["findings"][0].get("commit"), None);
    }

    #[test]
    fn an_entry_nobody_could_read_is_put_back_where_it_was() {
        // It was never handed to the caller — `read_tasks` skipped it — so the
        // caller writing without it cannot have meant "delete it". A hand-edit
        // with a typo in it is the user's to fix, not ours to erase.
        let before = json!({
            "tasks": [
                { "id": "keep-1", "title": "Fine" },
                { "id": "broken", "title": 7, "note": "typed by hand" },
                { "id": "keep-2", "title": "Also fine" },
                "not even an object",
            ],
        })
        .to_string();

        let after = rewritten(&before, &[task("keep-1", "Fine"), task("keep-2", "Also fine")]);

        let tasks = after["tasks"].as_array().expect("an array");
        assert_eq!(tasks.len(), 4);
        assert_eq!(tasks[0]["id"], "keep-1");
        assert_eq!(tasks[1]["title"], 7, "back at index 1");
        assert_eq!(tasks[1]["note"], "typed by hand");
        assert_eq!(tasks[2]["id"], "keep-2");
        assert_eq!(tasks[3], "not even an object");
    }

    #[test]
    fn a_duplicate_id_is_kept_in_the_file_even_though_it_is_not_a_card() {
        let before = json!({
            "tasks": [
                { "id": "same", "title": "The one that wins" },
                { "id": "same", "title": "The merge artefact" },
            ],
        })
        .to_string();

        let after = rewritten(&before, &[task("same", "The one that wins")]);

        let tasks = after["tasks"].as_array().expect("an array");
        assert_eq!(tasks.len(), 2, "the artefact is still the user's to resolve");
        assert_eq!(tasks[1]["title"], "The merge artefact");
    }

    #[test]
    fn deleting_a_card_still_deletes_it() {
        // The other half of the rule: `tasks` is authoritative about which
        // cards exist. Preservation is about FIELDS, not about resurrection.
        let before = json!({
            "tasks": [
                { "id": "a", "title": "T", "epic": "keep-me" },
                { "id": "b", "title": "U", "epic": "gone-with-b" },
            ],
        })
        .to_string();

        let after = rewritten(&before, &[task("a", "T")]);

        let tasks = after["tasks"].as_array().expect("an array");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["epic"], "keep-me");
    }

    #[test]
    fn a_board_written_over_nothing_has_only_what_it_was_given() {
        // No file, nothing to carry: the composer must not invent keys.
        let tmp = tempfile::tempdir().expect("tempdir");
        write_tasks(tmp.path(), &[task("a", "T")]).expect("written");

        let raw = fs::read_to_string(plan_path(tmp.path())).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["tasks", "version"]);
    }

    #[test]
    fn the_key_order_a_card_is_written_in_is_the_one_the_schema_declares() {
        // `TASK_KEYS` is what stops a preserved write from sorting a card
        // alphabetically. A field added to `RocTask` and not to that list would
        // land in the carried-forward tail instead of where it belongs, so the
        // two are pinned to each other here.
        let value = serde_json::to_value(task("a", "T")).expect("serializes");
        let mut declared: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        let mut listed: Vec<&str> = TASK_KEYS.to_vec();
        declared.sort_unstable();
        listed.sort_unstable();
        assert_eq!(declared, listed, "TASK_KEYS and RocTask disagree");

        // …and a written card really comes out in that order, unknown keys last.
        let before = json!({ "tasks": [ { "id": "a", "title": "T", "epic": "phase-4" } ] });
        let bytes = compose_plan(
            Some(parse_document(&before.to_string()).unwrap()),
            &[task("a", "T")],
        )
        .expect("composed");
        let raw = String::from_utf8(bytes).expect("utf-8");
        let at = |key: &str| raw.find(&format!("\"{key}\"")).unwrap_or_else(|| panic!("{key}"));
        for pair in TASK_KEYS.windows(2) {
            assert!(at(pair[0]) < at(pair[1]), "{} before {}: {raw}", pair[0], pair[1]);
        }
        assert!(at("updatedAt") < at("epic"), "{raw}");
    }

    #[test]
    fn the_keys_this_version_owns_stay_at_the_top_of_the_file() {
        // `serde_json::Map` is a `BTreeMap`, so composing the root as a map
        // would sort `tasks` above `version` and rewrite the head of every
        // board once, for nothing. Asserted on the TEXT, because the ordering
        // is a property of the file and not of the value it parses to.
        let before = json!({ "aardvark": true, "tasks": [] }).to_string();
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(tmp.path().join(PLAN_DIR)).unwrap();
        fs::write(plan_path(tmp.path()), before).unwrap();

        write_tasks(tmp.path(), &[task("a", "T")]).expect("written");

        let raw = fs::read_to_string(plan_path(tmp.path())).unwrap();
        let at = |key: &str| raw.find(&format!("\"{key}\"")).unwrap_or_else(|| panic!("{key}"));
        assert!(at("version") < at("tasks"), "{raw}");
        assert!(at("tasks") < at("aardvark"), "{raw}");
    }

    #[test]
    fn preservation_is_stable_across_repeated_writes() {
        // A save every 300 ms must not accumulate anything, reorder anything,
        // or lose what the save before it kept.
        let before = json!({
            "version": 2,
            "generatedBy": "RocSpace 2",
            "tasks": [
                { "id": "a", "title": "T", "epic": "phase-4" },
                { "id": "broken", "title": 7 },
            ],
        })
        .to_string();
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(tmp.path().join(PLAN_DIR)).unwrap();
        fs::write(plan_path(tmp.path()), &before).unwrap();

        for _ in 0..5 {
            let tasks = read_tasks(tmp.path()).expect("read");
            write_tasks(tmp.path(), &tasks).expect("written");
        }
        let first = fs::read_to_string(plan_path(tmp.path())).unwrap();
        let tasks = read_tasks(tmp.path()).expect("read");
        write_tasks(tmp.path(), &tasks).expect("written");
        let second = fs::read_to_string(plan_path(tmp.path())).unwrap();

        assert_eq!(first, second, "a save that is a no-op writes no change");
        let value: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(value["generatedBy"], "RocSpace 2");
        assert_eq!(value["tasks"][0]["epic"], "phase-4");
        assert_eq!(value["tasks"][1]["title"], 7);
    }

    #[test]
    fn a_file_with_no_tasks_key_is_an_empty_board() {
        assert_eq!(
            parse_plan(&json!({ "version": 1 }).to_string()).expect("parsed"),
            PlanRead::default()
        );
        assert_eq!(parse_plan("").expect("parsed"), PlanRead::default());
        assert_eq!(parse_plan("   \n").expect("parsed"), PlanRead::default());
    }

    #[test]
    fn a_corrupt_file_is_an_error_rather_than_an_empty_board() {
        // Answering "no tasks" here would let the next write replace a file the
        // user could still have recovered by hand.
        let tmp = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(tmp.path().join(PLAN_DIR)).unwrap();
        fs::write(plan_path(tmp.path()), b"{ \"tasks\": [ ").unwrap();

        let err = read_plan(tmp.path()).expect_err("corrupt files are errors");
        assert!(err.contains("plan.json"), "{err}");

        // …and so is a file of the wrong shape entirely.
        assert!(parse_plan("[]").is_err());
        assert!(parse_plan(&json!({ "tasks": "nope" }).to_string()).is_err());
    }

    // -- Atomicity ---------------------------------------------------------

    #[test]
    fn a_completed_write_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_tasks(tmp.path(), &[task("a", "T")]).expect("written");

        let names: Vec<String> = fs::read_dir(tmp.path().join(PLAN_DIR))
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![PLAN_FILE.to_string()]);
    }

    #[test]
    fn two_writes_never_share_a_temp_file() {
        // Two processes really do write this file — the app and the MCP server.
        // A temp path derived from the target alone is the same path for both,
        // so one truncates the file the other is about to rename.
        let dir = Path::new("/proj/.rocspace");
        let first = temp_path(dir);
        let second = temp_path(dir);

        assert_ne!(first, second);
        for temp in [&first, &second] {
            assert_eq!(temp.parent(), Some(dir), "must be a rename-able sibling");
            assert_eq!(temp.extension().and_then(|e| e.to_str()), Some("tmp"));
        }
    }

    #[test]
    fn concurrent_writes_leave_one_whole_readable_board() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project = tmp.path().to_path_buf();

        std::thread::scope(|scope| {
            for i in 0..8u32 {
                let project = project.clone();
                scope.spawn(move || {
                    let tasks: Vec<RocTask> = (0..20)
                        .map(|n| task(&format!("{i}-{n}"), &format!("writer {i}")))
                        .collect();
                    write_tasks(&project, &tasks).expect("written");
                });
            }
        });

        // Whichever write landed last, what is on disk is one whole board — not
        // a truncated one — and no temp files are left over.
        let tasks = read_tasks(&project).expect("read");
        assert_eq!(tasks.len(), 20);
        let names: Vec<String> = fs::read_dir(project.join(PLAN_DIR))
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![PLAN_FILE.to_string()]);
    }

    // -- The write lock ----------------------------------------------------

    #[test]
    fn concurrent_read_modify_writes_all_land() {
        // The bug: findings are contractually append-only, and read-then-write
        // made them last-writer-wins. Sixteen appends at once used to leave one
        // or two on the file, with every caller told it had succeeded.
        let tmp = tempfile::tempdir().expect("tempdir");
        let project = tmp.path().to_path_buf();
        write_tasks(&project, &[task("a", "T")]).expect("written");

        std::thread::scope(|scope| {
            for i in 0..16u32 {
                let project = project.clone();
                scope.spawn(move || {
                    update_plan(&project, |tasks| {
                        tasks[0].push_finding("you", format!("finding {i}"));
                        Ok(())
                    })
                    .expect("updated");
                });
            }
        });

        let tasks = read_tasks(&project).expect("read");
        assert_eq!(tasks[0].findings.len(), 16, "appends were lost");
        let mut texts: Vec<&str> = tasks[0].findings.iter().map(|f| f.text.as_str()).collect();
        texts.sort_unstable();
        texts.dedup();
        assert_eq!(texts.len(), 16, "two writers produced the same finding");
    }

    #[test]
    fn a_change_that_fails_writes_nothing_and_leaves_no_lock() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_tasks(tmp.path(), &[task("a", "T")]).expect("written");
        let before = fs::read_to_string(plan_path(tmp.path())).unwrap();

        let outcome: Result<(), String> = update_plan(tmp.path(), |tasks| {
            tasks.clear();
            Err("the card is not on this board".to_string())
        });

        assert_eq!(outcome, Err("the card is not on this board".to_string()));
        assert_eq!(fs::read_to_string(plan_path(tmp.path())).unwrap(), before);
        assert_eq!(
            fs::read_dir(tmp.path().join(PLAN_DIR))
                .unwrap()
                .flatten()
                .count(),
            1,
            "the lock outlived the call"
        );
    }

    #[test]
    fn a_lock_left_by_a_dead_writer_is_broken_rather_than_waited_out() {
        // A crashed agent must not wedge the board. The staleness rule is age,
        // because a pid means nothing across a reboot or a container boundary.
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join(PLAN_DIR);
        fs::create_dir_all(&dir).unwrap();
        let lock = dir.join(format!(".{PLAN_FILE}.lock"));
        fs::write(&lock, b"99999\n").unwrap();
        let ancient =
            SystemTime::now() - LOCK_STALE_AFTER - Duration::from_secs(60);
        set_modified(&lock, ancient);

        let start = Instant::now();
        write_tasks(tmp.path(), &[task("a", "T")]).expect("written");

        assert!(start.elapsed() < LOCK_WAIT_LIMIT, "waited for a dead holder");
        assert_eq!(read_tasks(tmp.path()).unwrap().len(), 1);
        assert!(!lock.exists(), "the lock was not released");
    }

    #[test]
    fn a_lock_a_live_writer_holds_is_respected() {
        // The other half: a lock that is NOT stale makes the next writer wait,
        // which is the whole point. Asserted by taking it and watching the
        // would-be writer still be blocked a moment later.
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join(PLAN_DIR);
        fs::create_dir_all(&dir).unwrap();
        let held = PlanLock::acquire(&dir).expect("taken");

        let project = tmp.path().to_path_buf();
        let writer = std::thread::spawn(move || write_tasks(&project, &[task("a", "T")]));
        std::thread::sleep(Duration::from_millis(150));
        assert!(!writer.is_finished(), "the lock did not hold anybody up");

        drop(held);
        writer.join().expect("thread").expect("written");
        assert_eq!(read_tasks(tmp.path()).unwrap().len(), 1);
    }

    /// Backdate a file's mtime. Only used to age a lock past its staleness
    /// timeout without a test that sleeps for ten seconds.
    fn set_modified(path: &Path, at: SystemTime) {
        let file = fs::OpenOptions::new().write(true).open(path).expect("open");
        file.set_modified(at).expect("set_modified");
    }

    #[test]
    fn a_reader_racing_a_writer_never_sees_half_a_board() {
        // The point of temp + rename: readers observe either the old file or
        // the new one, never a file being appended to.
        let tmp = tempfile::tempdir().expect("tempdir");
        let project = tmp.path().to_path_buf();
        write_tasks(&project, &[task("seed", "Seed")]).expect("written");

        std::thread::scope(|scope| {
            let writer = {
                let project = project.clone();
                scope.spawn(move || {
                    for round in 0..40 {
                        let tasks: Vec<RocTask> = (0..30)
                            .map(|n| task(&format!("{round}-{n}"), "busy"))
                            .collect();
                        write_tasks(&project, &tasks).expect("written");
                    }
                })
            };
            for _ in 0..200 {
                let read = read_plan(&project).expect("a reader never sees a partial file");
                assert_eq!(read.skipped, 0);
            }
            writer.join().expect("writer finished");
        });
    }

    #[test]
    fn writing_creates_the_rocspace_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project = tmp.path().join("nested").join("project");
        fs::create_dir_all(&project).unwrap();

        write_tasks(&project, &[]).expect("written");

        assert!(plan_path(&project).is_file());
        assert_eq!(read_tasks(&project).expect("read"), vec![]);
    }

    // -- Stamps ------------------------------------------------------------

    #[test]
    fn a_write_reports_the_stamp_the_file_ends_up_with() {
        // What makes self-write suppression work: the stamp taken from the temp
        // file before the rename is the stamp the published file has, because
        // `rename` does not touch mtime.
        let tmp = tempfile::tempdir().expect("tempdir");
        let stamp = write_tasks(tmp.path(), &[task("a", "T")]).expect("written");

        assert_eq!(stamp_of(tmp.path()), Some(stamp));
    }

    #[test]
    fn a_project_with_no_plan_file_has_no_stamp() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(stamp_of(tmp.path()), None);
    }

    #[test]
    fn a_changed_board_has_a_different_stamp() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let first = write_tasks(tmp.path(), &[task("a", "T")]).expect("written");
        let second = write_tasks(tmp.path(), &[task("a", "T"), task("b", "U")]).expect("written");

        assert_ne!(first, second);
    }

    #[test]
    fn an_edit_that_changes_no_byte_count_still_changes_the_stamp() {
        // A card going from `in_review` to `cancelled`. Both are nine
        // characters inside the quotes, so the file's LENGTH does not move —
        // and on a volume whose mtime resolution is a second (network mounts,
        // FAT), neither does the mtime. mtime + length alone called that "no
        // change", and the watcher never told the board the card had moved.
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut t = task("a", "T");
        t.status = RocTaskStatus::InReview;
        let before = write_tasks(tmp.path(), std::slice::from_ref(&t)).expect("written");

        t.status = RocTaskStatus::Cancelled;
        let after = write_tasks(tmp.path(), std::slice::from_ref(&t)).expect("written");

        assert_eq!(before.len, after.len, "the premise: same number of bytes");
        assert_ne!(before, after, "a status move that the watcher cannot see");
    }

    #[test]
    fn a_stamp_ignores_the_mtime_it_cannot_trust_but_not_the_content() {
        // Two files with identical bytes stamp the same apart from their
        // mtimes, and two with different bytes never stamp the same — which is
        // what makes the hash, rather than the clock, the thing that decides.
        let now = SystemTime::now();
        assert_eq!(
            stamp_of_bytes(Some(now), b"{\"tasks\":[]}"),
            stamp_of_bytes(Some(now), b"{\"tasks\":[]}")
        );
        assert_ne!(
            stamp_of_bytes(Some(now), b"{\"tasks\":[]}"),
            stamp_of_bytes(Some(now), b"{\"tasks\":[}}")
        );
    }
}
