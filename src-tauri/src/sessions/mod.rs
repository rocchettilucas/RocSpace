//! Named session store — the files behind "save this workspace and bring it
//! back later".
//!
//! One JSON file per saved session under `~/.rocspace/sessions/`, in the same
//! directory RocSpace already owns for the agent events file (see
//! `agents::rocspace_dir` — the home resolution is shared rather than
//! duplicated).
//!
//! The file is an envelope:
//!
//! ```json
//! { "meta": { "name": …, "savedAt": …, "workspaceName": …, "paneCount": … },
//!   "data": <whatever the renderer put there> }
//! ```
//!
//! `data` is opaque to Rust: this module never looks inside it, and
//! `session_list` deserializes only the `meta` half so listing twenty sessions
//! does not mean parsing twenty pane trees into a `Value` tree. The two meta
//! *hints* Rust does read off the payload — `workspaceName` and `paneCount` —
//! are documented top-level keys of the payload, not a claim about the rest of
//! it (see `meta_for`).
//!
//! The filename is a slug of the user's name, `[a-z0-9-]` only. That is a
//! containment boundary, not a cosmetic one: the name comes from a text field,
//! and `../../.ssh/authorized_keys` typed into it must not address anything
//! outside the sessions directory. Every path this module builds goes through
//! `slugify`, which cannot emit a separator, a dot, or a leading `~`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::agents::rocspace_dir;

/// Where the session files live, under RocSpace's home directory.
const SESSIONS_SUBDIR: &str = "sessions";

/// Longest slug we will write. Filesystems cap a component at 255 bytes and a
/// session name is a label, not a document — truncating keeps a pasted
/// paragraph from becoming an unwritable path. Two names that truncate to the
/// same slug collide, which is the same overwrite the renderer already confirms
/// for an exact repeat.
const MAX_SLUG_LEN: usize = 64;

/// What the sidebar and Settings › History list. Enough to render a row and to
/// address the file again — never the session's contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSessionMeta {
    /// The user's name for the session, as typed. `session_load` /
    /// `session_delete` take this value back and re-slug it, so a row in the
    /// list is directly actionable without the renderer knowing the slug rule.
    pub name: String,
    /// Milliseconds since the epoch, matching every other timestamp that
    /// crosses the IPC boundary.
    pub saved_at: i64,
    pub workspace_name: String,
    pub pane_count: u32,
}

/// The whole file. `data` is the renderer's payload, carried verbatim.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    meta: SavedSessionMeta,
    data: Value,
}

/// The `meta` half alone. Serde skips `data` with `IgnoredAny` rather than
/// building a `Value` for it, which is the whole point of listing this way.
#[derive(Debug, Deserialize)]
struct MetaOnly {
    meta: SavedSessionMeta,
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/// A filename-safe stem for `name`, or `None` when nothing survives.
///
/// Every character that is not ASCII alphanumeric becomes a separator, repeats
/// collapse, and leading/trailing separators are trimmed — so `[a-z0-9-]` is
/// the entire output alphabet and the result can never be `.`, `..`, or contain
/// `/` or `\`. `"../../etc/passwd"` slugs to `"etc-passwd"`: a file inside the
/// sessions directory, which is the containment this function exists for.
///
/// `None` (a name with no alphanumerics at all — `"~"`, `"..."`, `"???"`) is
/// rejected by the callers rather than defaulted, because guessing a filename
/// for a name the user cannot see is how a session gets lost.
pub fn slugify(name: &str) -> Option<String> {
    let mut out = String::new();
    // Starts true so a leading run of punctuation cannot open with a dash.
    let mut pending_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if out.len() >= MAX_SLUG_LEN {
                break;
            }
            out.push(ch.to_ascii_lowercase());
            pending_dash = false;
        } else if !pending_dash {
            if out.len() >= MAX_SLUG_LEN {
                break;
            }
            out.push('-');
            pending_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn slug_for(name: &str) -> Result<String, String> {
    slugify(name).ok_or_else(|| format!("\"{name}\" has no letters or digits to name a file with"))
}

fn session_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.json", slug_for(name)?)))
}

/// Writes in flight, this process. Only ever incremented — the value is a
/// discriminator, not a count of anything.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A scratch path in `dir` that no other write will pick.
///
/// Deriving it from the slug alone (`<slug>.json.tmp`) made every save of one
/// name use one temp file: two saves in flight together — this app's autosave
/// and a second window, or two clicks — would have one truncating the file the
/// other was about to rename, and the loser's `rename` moves whatever the
/// winner happened to have written by then. The pid separates processes, the
/// sequence separates writes inside one.
///
/// Still a sibling of the target, because `rename` is only atomic within one
/// filesystem, and still not a `.json`, so a temp file left by a crash is
/// invisible to `list_in`.
fn temp_path(dir: &Path, slug: &str) -> PathBuf {
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{slug}.{}.{seq}.tmp", std::process::id()))
}

/// Write `bytes` to `path` and wait for the disk to say so.
///
/// `sync_all` is the difference between "the file exists" and "the file has
/// our bytes in it after a power cut". Without it the rename can reach the
/// disk while the content it names is still in the page cache — which is
/// exactly the half-written file that temp-plus-rename exists to prevent.
fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

// ---------------------------------------------------------------------------
// Store operations (directory-parameterised so tests need no HOME)
// ---------------------------------------------------------------------------

/// `~/.rocspace/sessions`.
pub fn sessions_dir() -> PathBuf {
    rocspace_dir().join(SESSIONS_SUBDIR)
}

/// The meta a save records. `workspaceName` and `paneCount` are read off the
/// payload's top level: they are the two fields a list row needs, and asking
/// the renderer to repeat them there is cheaper than teaching Rust the rest of
/// the payload's shape. A payload that omits them still saves — the row just
/// falls back to the session's own name and no pane count.
fn meta_for(name: &str, payload: &Value) -> SavedSessionMeta {
    SavedSessionMeta {
        name: name.to_string(),
        saved_at: now_ms(),
        workspace_name: payload
            .get("workspaceName")
            .and_then(Value::as_str)
            .unwrap_or(name)
            .to_string(),
        pane_count: payload
            .get("paneCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32,
    }
}

/// Write `payload` as `<dir>/<slug>.json`, replacing whatever was there.
///
/// Temp file, `fsync`, rename: a crash or a full disk mid-write leaves the
/// previous save intact rather than a half-written file the next load cannot
/// parse, and the bytes are on the disk before the rename can publish them.
/// The temp file is a sibling with a name no other write will pick (see
/// `temp_path`), and it is cleaned up when the rename never happens.
///
/// The directory entry is synced too, best-effort: not every platform lets a
/// directory be opened, and a save that reached the file but not its parent's
/// metadata is still a save.
pub fn save_in(dir: &Path, name: &str, payload: Value) -> Result<SavedSessionMeta, String> {
    let slug = slug_for(name)?;
    let path = dir.join(format!("{slug}.json"));
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let meta = meta_for(name, &payload);
    let envelope = Envelope {
        meta: meta.clone(),
        data: payload,
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|e| format!("serialize: {e}"))?;

    let temp = temp_path(dir, &slug);
    if let Err(e) = write_durably(&temp, &bytes) {
        let _ = fs::remove_file(&temp);
        return Err(format!("write {}: {e}", temp.display()));
    }
    if let Err(e) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("rename into {}: {e}", path.display()));
    }
    let _ = fs::File::open(dir).and_then(|handle| handle.sync_all());
    Ok(meta)
}

/// Every saved session, newest first. A file that is missing, unreadable or not
/// a session envelope is skipped rather than failing the whole list: one bad
/// file must not hide the rest of the user's sessions.
pub fn list_in(dir: &Path) -> Result<Vec<SavedSessionMeta>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // Nothing saved yet is not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        if let Ok(MetaOnly { meta }) = serde_json::from_reader(std::io::BufReader::new(file)) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| {
        b.saved_at
            .cmp(&a.saved_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// The payload of a saved session — the `data` half of the envelope.
pub fn load_in(dir: &Path, name: &str) -> Result<Value, String> {
    let path = session_path(dir, name)?;
    let file = fs::File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let envelope: Envelope = serde_json::from_reader(std::io::BufReader::new(file))
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(envelope.data)
}

/// Forget a saved session. Deleting one that is already gone succeeds — the
/// caller asked for it to not be there.
pub fn delete_in(dir: &Path, name: &str) -> Result<(), String> {
    let path = session_path(dir, name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", path.display())),
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// All four are `async` for the reason the git and web-preview commands are: a
// synchronous Tauri command runs on the MAIN thread, and every one of these
// ends in a filesystem call. On a stalled volume that is a frozen window, not a
// slow list.

/// Save `payload` under `name`, overwriting any session with the same slug.
#[tauri::command]
#[specta::specta]
pub async fn session_save(name: String, payload: Value) -> Result<SavedSessionMeta, String> {
    save_in(&sessions_dir(), &name, payload)
}

/// Every saved session, newest first.
#[tauri::command]
#[specta::specta]
pub async fn session_list() -> Result<Vec<SavedSessionMeta>, String> {
    list_in(&sessions_dir())
}

/// The opaque payload the renderer saved under `name`.
#[tauri::command]
#[specta::specta]
pub async fn session_load(name: String) -> Result<Value, String> {
    load_in(&sessions_dir(), &name)
}

/// Delete the session saved under `name`.
#[tauri::command]
#[specta::specta]
pub async fn session_delete(name: String) -> Result<(), String> {
    delete_in(&sessions_dir(), &name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(workspace: &str, panes: u64) -> Value {
        json!({
            "workspaceName": workspace,
            "paneCount": panes,
            "workspace": { "accent": "violet" },
            "terminals": [],
        })
    }

    // -- Slug hardening ---------------------------------------------------
    //
    // The name is free text from a modal field. Every one of these used to be a
    // path the store would have written to.

    #[test]
    fn a_traversal_attempt_slugs_into_a_plain_filename() {
        assert_eq!(slugify("../x"), Some("x".to_string()));
        assert_eq!(slugify("../../etc/passwd"), Some("etc-passwd".to_string()));
        assert_eq!(slugify("a/b"), Some("a-b".to_string()));
        assert_eq!(slugify(r"a\b"), Some("a-b".to_string()));
    }

    #[test]
    fn a_name_that_is_only_punctuation_is_refused() {
        for hostile in ["", "   ", ".", "..", "...", "~", "/", "../..", "???"] {
            assert_eq!(slugify(hostile), None, "{hostile:?} must not name a file");
        }
    }

    #[test]
    fn the_slug_alphabet_is_lowercase_alphanumerics_and_dashes() {
        assert_eq!(slugify("My Session #2!"), Some("my-session-2".to_string()));
        let slug = slugify("Ünïcödé — ✨ Work 42").expect("has alphanumerics");
        assert!(
            slug.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "{slug}"
        );
        assert!(!slug.starts_with('-') && !slug.ends_with('-'), "{slug}");
        assert!(!slug.contains("--"), "{slug}");
    }

    #[test]
    fn a_very_long_name_is_truncated_to_a_writable_length() {
        let slug = slugify(&"ab ".repeat(200)).expect("has alphanumerics");
        assert!(slug.len() <= MAX_SLUG_LEN, "{} chars", slug.len());
        assert!(!slug.ends_with('-'), "{slug}");
    }

    #[test]
    fn a_hostile_name_writes_inside_the_sessions_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("sessions");
        save_in(&dir, "../../escape", payload("w", 1)).expect("saved");

        let written: Vec<_> = fs::read_dir(&dir)
            .expect("dir exists")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(written, vec!["escape.json".to_string()]);
        // …and nothing landed beside the sessions directory.
        assert!(!tmp.path().join("escape.json").exists());
    }

    #[test]
    fn a_name_with_no_slug_is_an_error_rather_than_a_default_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(save_in(tmp.path(), "~", payload("w", 1)).is_err());
        assert!(load_in(tmp.path(), "..").is_err());
        assert!(delete_in(tmp.path(), "...").is_err());
    }

    // -- Round trip -------------------------------------------------------

    #[test]
    fn a_saved_session_loads_back_byte_for_byte() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data = json!({
            "workspaceName": "rocspace",
            "paneCount": 4,
            "paneTree": { "kind": "leaf", "terminalId": "t1" },
            "nested": { "deep": [1, 2, { "ok": true }] },
        });

        save_in(tmp.path(), "My Session", data.clone()).expect("saved");

        assert_eq!(load_in(tmp.path(), "My Session").expect("loaded"), data);
    }

    #[test]
    fn the_meta_records_the_name_as_typed_and_the_payloads_hints() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = save_in(tmp.path(), "Friday Review", payload("rocspace", 6)).expect("saved");

        assert_eq!(meta.name, "Friday Review");
        assert_eq!(meta.workspace_name, "rocspace");
        assert_eq!(meta.pane_count, 6);
        assert!(meta.saved_at > 0);
    }

    #[test]
    fn a_payload_without_hints_still_saves() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = save_in(tmp.path(), "bare", json!({ "anything": true })).expect("saved");

        assert_eq!(meta.workspace_name, "bare");
        assert_eq!(meta.pane_count, 0);
    }

    #[test]
    fn a_name_that_differs_only_in_case_or_punctuation_overwrites() {
        // Same slug, same file — which is what the renderer confirms before
        // calling. Two files for "My Session" and "my session" would be two
        // rows the user cannot tell apart.
        let tmp = tempfile::tempdir().expect("tempdir");
        save_in(tmp.path(), "My Session", payload("first", 1)).expect("saved");
        save_in(tmp.path(), "my  session!", payload("second", 8)).expect("saved");

        let list = list_in(tmp.path()).expect("listed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].workspace_name, "second");
        assert_eq!(list[0].name, "my  session!", "the newest name wins");
    }

    // -- Listing ----------------------------------------------------------

    #[test]
    fn listing_a_directory_that_does_not_exist_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            list_in(&tmp.path().join("never-saved")).expect("listed"),
            vec![]
        );
    }

    #[test]
    fn listing_is_newest_first() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for name in ["one", "two", "three"] {
            save_in(tmp.path(), name, payload(name, 1)).expect("saved");
        }
        // `saved_at` has millisecond resolution and three writes can land in
        // one millisecond, so assert the ordering key rather than the names.
        let list = list_in(tmp.path()).expect("listed");
        assert_eq!(list.len(), 3);
        assert!(list.windows(2).all(|w| w[0].saved_at >= w[1].saved_at));
    }

    #[test]
    fn a_corrupt_file_is_skipped_and_the_rest_still_list() {
        let tmp = tempfile::tempdir().expect("tempdir");
        save_in(tmp.path(), "good", payload("good", 2)).expect("saved");
        fs::write(tmp.path().join("broken.json"), b"{ not json").expect("wrote");
        fs::write(tmp.path().join("notes.txt"), b"ignored").expect("wrote");

        let list = list_in(tmp.path()).expect("listed");

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "good");
    }

    // -- Delete + atomicity ------------------------------------------------

    #[test]
    fn deleting_removes_it_from_the_list_and_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        save_in(tmp.path(), "gone soon", payload("w", 1)).expect("saved");

        delete_in(tmp.path(), "gone soon").expect("deleted");
        delete_in(tmp.path(), "gone soon").expect("deleting twice is fine");

        assert!(list_in(tmp.path()).expect("listed").is_empty());
        assert!(load_in(tmp.path(), "gone soon").is_err());
    }

    #[test]
    fn a_completed_save_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().expect("tempdir");
        save_in(tmp.path(), "clean", payload("w", 1)).expect("saved");

        let names: Vec<_> = fs::read_dir(tmp.path())
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["clean.json".to_string()]);
    }

    #[test]
    fn two_writes_of_one_name_never_share_a_temp_file() {
        // The deterministic half of the race below: a temp path derived from
        // the slug alone is the same path for every writer of that name, so
        // one truncates the file the other is about to rename.
        let dir = Path::new("/sessions");
        let first = temp_path(dir, "my-session");
        let second = temp_path(dir, "my-session");

        assert_ne!(first, second);
        for temp in [&first, &second] {
            assert_eq!(temp.parent(), Some(dir), "must be a rename-able sibling");
            assert_eq!(temp.extension().and_then(|e| e.to_str()), Some("tmp"));
            // …which is what keeps a crashed write out of `list_in`.
            assert_ne!(temp.extension().and_then(|e| e.to_str()), Some("json"));
        }
    }

    #[test]
    fn concurrent_saves_of_one_name_leave_one_readable_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_path_buf();

        std::thread::scope(|scope| {
            for i in 0..8u64 {
                let dir = dir.clone();
                scope.spawn(move || {
                    save_in(&dir, "same name", payload(&format!("w{i}"), i)).expect("saved");
                });
            }
        });

        // Whichever write landed last, what is on disk is one whole session
        // file — not a truncated one, and not a directory littered with the
        // temp files of the writers that lost.
        let names: Vec<_> = fs::read_dir(&dir)
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["same-name.json".to_string()]);
        let data = load_in(&dir, "same name").expect("loaded");
        assert!(data.get("workspaceName").is_some(), "{data}");
        assert_eq!(list_in(&dir).expect("listed").len(), 1);
    }

    #[test]
    fn the_envelope_keeps_meta_and_data_separate_on_disk() {
        // `list_in` reads only `meta`, so the shape it reads has to be the
        // shape `save_in` writes.
        let tmp = tempfile::tempdir().expect("tempdir");
        save_in(tmp.path(), "shape", payload("rocspace", 2)).expect("saved");

        let raw = fs::read_to_string(tmp.path().join("shape.json")).expect("read");
        let value: Value = serde_json::from_str(&raw).expect("valid JSON");

        assert_eq!(value["meta"]["name"], "shape");
        assert!(value["meta"]["savedAt"].as_i64().is_some());
        assert_eq!(value["meta"]["workspaceName"], "rocspace");
        assert_eq!(value["meta"]["paneCount"], 2);
        assert_eq!(value["data"]["workspaceName"], "rocspace");
    }

    #[test]
    fn the_sessions_directory_sits_under_the_rocspace_dir() {
        assert!(sessions_dir().ends_with(PathBuf::from(".rocspace").join(SESSIONS_SUBDIR)));
    }
}
