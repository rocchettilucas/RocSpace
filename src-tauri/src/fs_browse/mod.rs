//! Filesystem access for the in-app code editor.
//!
//! Three commands — list a directory, read a UTF-8 file, write one back — all
//! confined to the active project root via `canonicalize`+`starts_with`. The
//! frontend's `EditorView` calls these to populate its file tree, fill its
//! Monaco buffer, and (since the editor became writable) answer ⌘S.
//!
//! Every one of them is an `async fn` over a `_blocking` worker, for the reason
//! the git commands in `lib.rs` spell out: a synchronous Tauri command runs on
//! the MAIN thread, and blocking the main thread is a frozen window rather than
//! a slow answer. These are the module where that matters most — `fs_write_file`
//! ends in two `fsync`s, which on a network volume or a sleeping external disk
//! block for as long as the kernel makes them, and ⌘P's index walk issues one
//! `fs_read_dir` per directory of the project (its concurrency bound means
//! nothing if the calls queue behind each other on one thread).
//!
//! `spawn_blocking` rather than a bare `async fn`, because an `async fn` full of
//! blocking IO only moves the stall from the main thread to an async worker: the
//! blocking pool is where a call that may take a second belongs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::spawn_blocking;

/// Files larger than this are refused, on the way in and on the way out.
/// Monaco performance falls off a cliff past a few MB, and a buffer on its way
/// to disk is only ever something this same cap already let through.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    /// Absolute, canonicalized path.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// True for entries whose name starts with `.`. Frontend dims these.
    pub hidden: bool,
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileContentsDto {
    pub path: String,
    pub content: String,
    pub size: u64,
    /// Best-guess language id for Monaco, derived from extension. None means
    /// "let Monaco decide" (it falls back to plain text).
    pub language: Option<String>,
    /// Whether a save of this file would be allowed — the same question
    /// `fs_write_file` refuses on, asked while the file is being opened. Both
    /// halves of it: the file has to be writable AND its directory has to
    /// accept the scratch file the atomic write puts there.
    ///
    /// It travels with the CONTENT because the editor has to decide whether to
    /// hand the user a buffer before they have typed anything: an editable
    /// pane over a file that cannot be written is an invitation to lose an
    /// edit, and a permission error is a much better answer at open time than
    /// at ⌘S. A moment out of date by definition — `fs_write_file` asks again,
    /// and its answer is the one that matters.
    pub writable: bool,
}

/// Run one filesystem job on the blocking pool and unwrap the join.
///
/// A join can only fail if the worker panicked or the runtime is shutting down;
/// either way the caller gets a string it can show, not a silent `Ok`.
async fn off_thread<T, F>(job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match spawn_blocking(job).await {
        Ok(result) => result,
        Err(e) => Err(format!("filesystem task failed: {e}")),
    }
}

/// Canonicalize `target` and verify it is the same as, or descends from,
/// `root`. Returns the canonical target on success.
///
/// Rejects: non-existent paths, paths outside `root`, IO errors.
fn ensure_within_root(root: &str, target: &str) -> Result<PathBuf, String> {
    let root_canonical = fs::canonicalize(root)
        .map_err(|e| format!("project root not accessible: {e}"))?;
    let target_canonical = fs::canonicalize(target)
        .map_err(|e| format!("path not accessible: {e}"))?;
    if !target_canonical.starts_with(&root_canonical) {
        return Err("path is outside the project root".into());
    }
    Ok(target_canonical)
}

fn extension_to_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "css" => "css",
        "scss" | "sass" => "scss",
        "html" | "htm" => "html",
        "rs" => "rust",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" | "psm1" => "powershell",
        "sql" => "sql",
        "xml" => "xml",
        "lock" => "yaml",
        "dockerfile" => "dockerfile",
        _ => return None,
    };
    Some(lang.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn fs_read_dir(
    project_root: String,
    path: String,
) -> Result<Vec<DirEntryDto>, String> {
    off_thread(move || read_dir_blocking(project_root, path)).await
}

fn read_dir_blocking(
    project_root: String,
    path: String,
) -> Result<Vec<DirEntryDto>, String> {
    let target = ensure_within_root(&project_root, &path)?;
    let read = fs::read_dir(&target).map_err(|e| format!("read_dir failed: {e}"))?;

    let mut entries: Vec<DirEntryDto> = Vec::new();
    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        let entry_path = item.path();
        let metadata = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = metadata.is_dir();
        // Skip symlinks pointing outside the project root — easier than
        // resolving them per entry, and they're rarely useful in a code editor.
        if metadata.file_type().is_symlink() {
            continue;
        }
        entries.push(DirEntryDto {
            hidden: name.starts_with('.'),
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { metadata.len() },
        });
    }

    // Dirs first, then files; case-insensitive alphabetical within each group.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a UTF-8 file inside the project root, with the two things the editor
/// needs before it can show it: a language hint for Monaco, and whether a save
/// would be allowed at all (see `FileContentsDto::writable`).
#[tauri::command]
#[specta::specta]
pub async fn fs_read_file(
    project_root: String,
    path: String,
) -> Result<FileContentsDto, String> {
    off_thread(move || read_file_blocking(project_root, path)).await
}

fn read_file_blocking(
    project_root: String,
    path: String,
) -> Result<FileContentsDto, String> {
    let target = ensure_within_root(&project_root, &path)?;
    let metadata = fs::metadata(&target).map_err(|e| format!("stat failed: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".into());
    }
    let size = metadata.len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "file is {size} bytes; the editor refuses files larger than {MAX_FILE_BYTES} bytes"
        ));
    }

    let bytes = fs::read(&target).map_err(|e| format!("read failed: {e}"))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "binary or non-utf8 file".to_string())?;

    // BOTH halves, because the save needs both — see `dir_write_permitted`.
    let writable = write_permitted(&target).is_ok()
        && target
            .parent()
            .is_some_and(|dir| dir_write_permitted(dir).is_ok());

    Ok(FileContentsDto {
        language: extension_to_language(&target),
        writable,
        path: target.to_string_lossy().to_string(),
        content,
        size,
    })
}

/// Writes in flight, this process. Only ever incremented — the value is a
/// discriminator, not a count of anything.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A scratch path beside the file being written that no other write will pick.
///
/// A sibling, because `rename` is only atomic within one filesystem and the
/// project may well be on a different one from `/tmp`. A dotfile with a name
/// nothing else uses, so a temp left behind by a crash is recognisable as ours.
/// The pid separates processes and the sequence separates writes inside one:
/// two saves of the same file in flight together must not share a scratch path,
/// or the loser's `rename` publishes whatever the winner had written by then —
/// the same bug the sessions store's `temp_path` exists to avoid.
fn write_temp_path(dir: &Path) -> PathBuf {
    let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".rocspace-write.{}.{seq}.tmp", std::process::id()))
}

/// Write `bytes` to `path` under `mode`, and wait for the disk to say so.
///
/// `sync_all` is the difference between "the file exists" and "the file has our
/// bytes in it after a power cut". Without it the rename can reach the disk
/// while the content it names is still in the page cache — which is exactly the
/// half-written file that temp-plus-rename exists to prevent.
///
/// The mode goes on BEFORE the bytes. A temp file is born 0644, so filling it
/// first and narrowing it afterwards publishes the contents of a 0600 file — a
/// `.env`, a private key, anything the user restricted on purpose — at 0644 in
/// their project directory for the length of the write. Setting it on the empty
/// file leaks nothing and gets the mode into the same `fsync` as the data.
/// Best-effort, as it was: a save that landed but could not carry the mode
/// across is still a save, and the alternative is throwing the edit away.
fn write_durably(
    path: &Path,
    bytes: &[u8],
    mode: &fs::Permissions,
) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    #[cfg(unix)]
    {
        let _ = file.set_permissions(mode.clone());
    }
    #[cfg(not(unix))]
    {
        // Windows `Permissions` carries only the read-only flag, and setting
        // that here would make the write below fail. The mode is not carried
        // across there at all — it never was.
        let _ = mode;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Can this process replace the bytes of `target`?
///
/// Asked of the kernel by opening the file for writing, not guessed from its
/// mode bits: a file owned by somebody else, an ACL, an immutable flag and a
/// filesystem mounted read-only all answer here, and `permissions()` shows none
/// of them. Nothing is written and nothing is truncated — the handle is opened
/// and dropped, which is the cheapest way to ask the question the write is
/// about to assume the answer to.
fn write_permitted(target: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).open(target).map(drop)
}

/// Can this process create the scratch file the save needs beside `target`?
///
/// The other half of the question, and for a long time the missing one. The
/// write never opens the target: it fills a sibling temp in this directory and
/// renames it over the top, so a 0644 file inside a 0555 directory is one the
/// kernel says yes to and the save still cannot happen. Answered by creating
/// and removing exactly the kind of scratch file `write_file_blocking` would,
/// for the reason `write_permitted` opens the file rather than reading its
/// mode: ownership, ACLs and a read-only mount all live here.
fn dir_write_permitted(dir: &Path) -> std::io::Result<()> {
    let probe = write_temp_path(dir);
    fs::File::create(&probe)?;
    // Best-effort, like every other cleanup of a scratch path here: the answer
    // is already known, and a probe that outlived its question is recognisable
    // as ours by name.
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Overwrite a file inside the project root with `contents`.
///
/// The same sandbox as `fs_read_file`, plus four refusals the read side does
/// not need:
///
///  - **Symlinks.** `canonicalize` follows them, so a link inside the root
///    pointing outside it is already caught by `starts_with` — but one pointing
///    at another file *inside* the root would pass, and the rename below would
///    replace the LINK with a regular file. `symlink_metadata` on the path as
///    given is what says no; on the canonical path it never could.
///  - **Anything that is not already a regular file.** This replaces what the
///    editor opened; it does not create files and does not make directories. A
///    path that does not exist is nothing the editor can have opened, so it is
///    a bug or an escape attempt rather than a new file.
///  - **Oversize buffers**, against the same cap the read side enforces.
///  - **A file this process may not write.** temp + rename needs a writable
///    DIRECTORY and asks nothing of the file, so without this check a 0444
///    file — or one owned by somebody else — is replaced and then has its old
///    mode restored on top of the replacement, which leaves precisely nothing
///    to show that it happened. The editor gets the kernel's own words instead
///    and the file keeps its contents.
///
/// The write is temp + `fsync` + `rename`: a crash or a full disk mid-write
/// leaves the previous contents intact rather than a truncated file, and the
/// bytes are on the disk before the rename can publish them. The mode is
/// carried across on Unix — a temp file is born 0644, and a save that quietly
/// took the executable bit off a script is a bug found much later.
///
/// Emits nothing: the frontend owns dirty state and decides what a save means.
#[tauri::command]
#[specta::specta]
pub async fn fs_write_file(
    project_root: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    off_thread(move || write_file_blocking(project_root, path, contents)).await
}

fn write_file_blocking(
    project_root: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    // Cheapest refusal first — no reason to touch the disk for a buffer that is
    // going to be rejected anyway.
    let len = contents.len() as u64;
    if len > MAX_FILE_BYTES {
        return Err(format!(
            "buffer is {len} bytes; the editor refuses to write more than \
             {MAX_FILE_BYTES} bytes"
        ));
    }

    // The link status of the path AS GIVEN, before canonicalize resolves it
    // away.
    let link_meta = fs::symlink_metadata(&path)
        .map_err(|e| format!("path not accessible: {e}"))?;
    if link_meta.file_type().is_symlink() {
        return Err("path is a symlink; refusing to write through it".into());
    }

    let target = ensure_within_root(&project_root, &path)?;
    let metadata = fs::metadata(&target).map_err(|e| format!("stat failed: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".into());
    }
    // Before anything is written, not after: the rename would succeed on a file
    // this process cannot write, and the mode carried across afterwards would
    // hide that it ever did.
    if let Err(e) = write_permitted(&target) {
        return Err(format!("{} is not writable: {e}", target.display()));
    }

    let dir = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;

    let temp = write_temp_path(dir);
    if let Err(e) = write_durably(&temp, contents.as_bytes(), &metadata.permissions())
    {
        let _ = fs::remove_file(&temp);
        // Named for the file the user pressed ⌘S on. The failure is really the
        // scratch file's, but `write /project/.rocspace-write.4711.3.tmp:
        // Permission denied` is a sentence about a path they have never seen
        // and cannot act on — the directory it names is the actionable part,
        // and the target carries that.
        return Err(format!("write {}: {e}", target.display()));
    }
    if let Err(e) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("rename into {}: {e}", target.display()));
    }
    // The directory entry too, best-effort: not every platform lets a directory
    // be opened, and a save that reached the file but not its parent's metadata
    // is still a save.
    let _ = fs::File::open(dir).and_then(|handle| handle.sync_all());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(path: &Path, content: &[u8]) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content).unwrap();
    }

    #[test]
    fn read_dir_sorts_dirs_first_then_alphabetical() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join("zeta_dir")).unwrap();
        std::fs::create_dir(root.join("alpha_dir")).unwrap();
        write_file(&root.join("beta.txt"), b"x");
        write_file(&root.join("Alpha.txt"), b"x");

        let root_str = root.to_str().unwrap().to_string();
        let entries = read_dir_blocking(root_str.clone(), root_str).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha_dir", "zeta_dir", "Alpha.txt", "beta.txt"]);
    }

    #[test]
    fn read_dir_rejects_path_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();

        let err = read_dir_blocking(
            root.to_str().unwrap().to_string(),
            outside.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("outside the project root"), "got: {err}");
    }

    #[test]
    fn read_file_rejects_non_utf8() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let bin = root.join("blob.bin");
        write_file(&bin, &[0xff, 0xfe, 0x00, 0x80]);
        let err = read_file_blocking(
            root.to_str().unwrap().to_string(),
            bin.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("binary"), "got: {err}");
    }

    #[test]
    fn read_file_rejects_oversize() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let big = root.join("big.txt");
        // Just over the cap.
        let oversize = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        write_file(&big, &oversize);
        let err = read_file_blocking(
            root.to_str().unwrap().to_string(),
            big.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("refuses"), "got: {err}");
    }

    /// Every scratch file this module makes is a dotfile ending `.tmp`. A
    /// successful write must leave none behind, and a refused one must never
    /// have made one.
    fn temp_files_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn write_file_replaces_the_contents_and_leaves_no_temp_behind() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("notes.md");
        write_file(&file, b"before");

        write_file_blocking(
            root.to_str().unwrap().to_string(),
            file.to_str().unwrap().to_string(),
            "after".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        assert!(temp_files_in(root).is_empty(), "scratch file left behind");
    }

    #[test]
    fn write_file_rejects_path_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("secrets.txt");
        write_file(&outside, b"original");

        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            outside.to_str().unwrap().to_string(),
            "clobbered".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("outside the project root"), "got: {err}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original");
    }

    #[test]
    fn write_file_rejects_a_traversal_out_of_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("secrets.txt");
        write_file(&outside, b"original");

        let escape = root.join("..").join("secrets.txt");
        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            escape.to_str().unwrap().to_string(),
            "clobbered".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("outside the project root"), "got: {err}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn write_file_refuses_to_write_through_a_symlink() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let real = root.join("real.txt");
        write_file(&real, b"original");
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Both ends are inside the root, so the sandbox alone would let this
        // through — the link check is the whole refusal.
        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            link.to_str().unwrap().to_string(),
            "through the link".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("symlink"), "got: {err}");
        assert_eq!(fs::read_to_string(&real).unwrap(), "original");
        let still_a_link = fs::symlink_metadata(&link).unwrap();
        assert!(still_a_link.file_type().is_symlink());
    }

    #[test]
    fn write_file_rejects_oversize_without_touching_the_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("big.txt");
        write_file(&file, b"original");

        let oversize = "a".repeat((MAX_FILE_BYTES + 1) as usize);
        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            file.to_str().unwrap().to_string(),
            oversize,
        )
        .unwrap_err();
        assert!(err.contains("refuses"), "got: {err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        assert!(temp_files_in(root).is_empty(), "scratch file left behind");
    }

    #[test]
    fn write_file_refuses_a_path_that_is_not_already_a_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let dir = root.join("src");
        fs::create_dir(&dir).unwrap();

        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            dir.to_str().unwrap().to_string(),
            "x".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("not a file"), "got: {err}");

        let missing = root.join("nope.txt");
        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            missing.to_str().unwrap().to_string(),
            "x".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("not accessible"), "got: {err}");
        assert!(!missing.exists(), "the write invented a file");
    }

    /// The read side carries the same answer, so the editor can decline to
    /// hand out a buffer it would not be able to write — an editable pane over
    /// a locked file is an invitation to type an edit that has nowhere to go.
    #[cfg(unix)]
    #[test]
    fn read_file_reports_whether_a_save_would_be_allowed() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let root_str = root.to_str().unwrap().to_string();
        let open = root.join("open.md");
        write_file(&open, b"x");
        let locked = root.join("locked.md");
        write_file(&locked, b"x");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();

        let readable =
            read_file_blocking(root_str.clone(), open.to_str().unwrap().to_string())
                .unwrap();
        assert!(readable.writable);
        let protected =
            read_file_blocking(root_str, locked.to_str().unwrap().to_string())
                .unwrap();
        // Readable, and not writable: the editor shows it and says so.
        assert_eq!(protected.content, "x");
        assert!(!protected.writable);
    }

    /// The gap the file-only check left: temp + rename asks nothing of the
    /// file and everything of the DIRECTORY, so a 0644 file in a directory
    /// this process cannot create in answered `writable: true`. No read-only
    /// banner, Monaco took the edits, and ⌘S was the first anyone heard of it.
    #[cfg(unix)]
    #[test]
    fn read_file_reports_a_writable_file_in_a_locked_directory_as_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let locked_dir = root.join("locked");
        fs::create_dir(&locked_dir).unwrap();
        let file = locked_dir.join("note.md");
        write_file(&file, b"x");
        // The file itself is perfectly writable; its directory is not.
        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let dto = read_file_blocking(
            root.to_str().unwrap().to_string(),
            file.to_str().unwrap().to_string(),
        )
        .unwrap();

        // Restored first, so a failure below does not leave a directory the
        // TempDir cannot clean up.
        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(dto.content, "x");
        assert!(!dto.writable, "the save would fail — say so before the edit");
    }

    /// The other half of the same gap: when the scratch write does fail, the
    /// sentence has to name the file the user pressed ⌘S on. `write
    /// /project/.rocspace-write.4711.3.tmp: Permission denied` is true and
    /// unusable — it names a path they have never seen.
    #[cfg(unix)]
    #[test]
    fn write_file_names_the_target_when_the_scratch_write_fails() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let locked_dir = root.join("locked");
        fs::create_dir(&locked_dir).unwrap();
        let file = locked_dir.join("note.md");
        write_file(&file, b"original");
        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            file.to_str().unwrap().to_string(),
            "edited".to_string(),
        )
        .unwrap_err();

        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.contains("note.md"), "got: {err}");
        assert!(
            !err.contains(".rocspace-write"),
            "the scratch file's name leaked: {err}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    }

    /// The one the atomic write would otherwise walk straight through: temp +
    /// rename never opens the target, so a read-only file used to be replaced
    /// and then handed its old 0444 back — a save the user was told nothing
    /// about, on a file they had deliberately protected.
    #[cfg(unix)]
    #[test]
    fn write_file_refuses_a_file_it_may_not_write() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let locked = root.join("locked.md");
        write_file(&locked, b"original");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();

        let err = write_file_blocking(
            root.to_str().unwrap().to_string(),
            locked.to_str().unwrap().to_string(),
            "clobbered".to_string(),
        )
        .unwrap_err();

        assert!(err.contains("not writable"), "got: {err}");
        assert_eq!(fs::read_to_string(&locked).unwrap(), "original");
        let mode = fs::metadata(&locked).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o444, "the refusal changed the file's mode");
        assert!(temp_files_in(root).is_empty(), "scratch file left behind");
    }

    #[cfg(unix)]
    #[test]
    fn write_file_keeps_the_files_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let script = root.join("run.sh");
        write_file(&script, b"#!/bin/sh\necho old\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        write_file_blocking(
            root.to_str().unwrap().to_string(),
            script.to_str().unwrap().to_string(),
            "#!/bin/sh\necho new\n".to_string(),
        )
        .unwrap();

        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "the executable bit did not survive the save");

        // The other direction, and the one the ordering inside `write_durably`
        // is about: a file the user narrowed on purpose keeps its mode, and the
        // scratch file it passed through is never wider than it is.
        let secret = root.join(".env");
        write_file(&secret, b"TOKEN=old\n");
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();

        write_file_blocking(
            root.to_str().unwrap().to_string(),
            secret.to_str().unwrap().to_string(),
            "TOKEN=new\n".to_string(),
        )
        .unwrap();

        let mode = fs::metadata(&secret).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the save widened a file the user restricted");
    }

    #[test]
    fn write_file_round_trips_through_read_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("a.ts");
        write_file(&file, b"const a = 1;");
        let root_str = root.to_str().unwrap().to_string();
        let path_str = file.to_str().unwrap().to_string();

        write_file_blocking(
            root_str.clone(),
            path_str.clone(),
            "const a = 2;\n".to_string(),
        )
        .unwrap();

        let back = read_file_blocking(root_str, path_str).unwrap();
        assert_eq!(back.content, "const a = 2;\n");
        assert_eq!(back.size, 13);
    }

    /// The commands themselves, not the `_blocking` workers every other test
    /// calls: the wrappers are where the `spawn_blocking` hop lives, and a
    /// suite that only ever exercised the halves underneath them would not
    /// notice the day one stopped resolving at all.
    #[tokio::test]
    async fn the_async_commands_round_trip_through_the_blocking_pool() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(&root.join("a.ts"), b"const a = 1;");
        let root_str = root.to_str().unwrap().to_string();
        let path_str = root.join("a.ts").to_str().unwrap().to_string();

        let entries = fs_read_dir(root_str.clone(), root_str.clone())
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);

        fs_write_file(
            root_str.clone(),
            path_str.clone(),
            "const a = 2;\n".to_string(),
        )
        .await
        .unwrap();
        let back = fs_read_file(root_str, path_str).await.unwrap();
        assert_eq!(back.content, "const a = 2;\n");
    }

    #[test]
    fn write_scratch_paths_are_unique_siblings() {
        let dir = Path::new("/tmp/rocspace-test");
        let a = write_temp_path(dir);
        let b = write_temp_path(dir);
        assert_ne!(a, b, "two writes would share a scratch file");
        assert_eq!(a.parent(), Some(dir), "scratch file is not a sibling");
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(".rocspace-write."), "got: {name}");
        assert!(name.ends_with(".tmp"), "got: {name}");
    }

    #[test]
    fn read_file_returns_language_hint_from_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("Foo.tsx");
        write_file(&file, b"const x: number = 1;");
        let contents = read_file_blocking(
            root.to_str().unwrap().to_string(),
            file.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(contents.language.as_deref(), Some("typescript"));
        assert_eq!(contents.content, "const x: number = 1;");
        assert_eq!(contents.size, 20);
    }
}
