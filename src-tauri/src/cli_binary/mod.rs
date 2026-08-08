//! Where the agent CLIs actually are.
//!
//! One question — "what do I exec for `claude`?" — asked by two callers that
//! used to answer it differently. `roc_brain` has resolved it to an absolute
//! path since Phase 4, for the reason its module docs spell out: **PATH is the
//! trap.** A packaged RocSpace launched from Finder inherits
//! `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no nvm, no Homebrew, no
//! `~/.local/bin` — and `claude` is almost always in one of those.
//!
//! The panes never asked. `pty::runtime` handed the bare name to
//! `$SHELL -c 'clear; exec claude …'`, and `-c` is NOT interactive: `zsh` reads
//! `~/.zshenv` and stops, while the Claude Code installer (and nvm, and fnm,
//! and `brew shellenv`) writes its PATH line into `~/.zshrc`, which only an
//! interactive shell sources. So every agent pane in the shipped app flashed
//! `zsh:1: command not found: claude` and died, on a machine where typing
//! `claude` into Terminal works — and where a plain Shell pane, which gets a
//! real interactive PTY, could run it by hand.
//!
//! So the resolution lives here rather than inside either caller, and it is
//! generic over the binary name: `codex` and `opencode` reach the PTY the same
//! way `claude` does and were just as broken.
//!
//! The order is the point, and each step earns its place:
//!
//!   1. **This process's PATH.** Free, and the answer whenever RocSpace was
//!      started from a terminal — every development run, and a fair number of
//!      real ones.
//!   2. **The user's own shell, INTERACTIVELY.** The step the packaged app
//!      lives or dies by; see `interactive_shell_path`.
//!   3. **The handful of places the tool installs itself to.** Guessing, so it
//!      is last, and it only runs when neither of the above could say.
//!
//! A HIT is remembered for the life of the process and a MISS never is, and a
//! miss is a typed sentence naming the fix rather than a silent nothing.
//!
//! Step 2 is also lent out. `shell_env` asks the same shell a different
//! question — "what is the whole environment you would have given me?" — and
//! starting an interactive shell safely (bounded, drained, `-lic` then `-ic`,
//! `getpwuid_r` when `$SHELL` is unset) is the awkward part of both. It lives
//! here, in `ask_interactively`, rather than being written twice.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

// ---------------------------------------------------------------------------
// The CLIs this app launches by name
// ---------------------------------------------------------------------------

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";
pub const OPENCODE: &str = "opencode";

/// What the user is told when there is no `claude` to run. Actionable on
/// purpose — "not found" alone is a dead end, and this is the one failure that
/// every part of the voice phase depends on being unmissable.
pub const CLAUDE_NOT_FOUND: &str = concat!(
    "Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code), ",
    "or set ROCSPACE_CLAUDE_BIN to the full path of the `claude` binary."
);

const CODEX_NOT_FOUND: &str = concat!(
    "Codex CLI not found. Install it (npm install -g @openai/codex), ",
    "or set ROCSPACE_CODEX_BIN to the full path of the `codex` binary."
);

const OPENCODE_NOT_FOUND: &str = concat!(
    "OpenCode CLI not found. Install it (npm install -g opencode-ai), ",
    "or set ROCSPACE_OPENCODE_BIN to the full path of the `opencode` binary."
);

/// A CLI RocSpace knows by name: what to say when it is missing, and the
/// directories its own installer writes to.
struct Known {
    name: &'static str,
    not_found: &'static str,
    /// Under `$HOME`, in the order a machine is likely to have it. Written with
    /// forward slashes and joined component by component so this stays one
    /// table on every platform.
    home_dirs: &'static [&'static str],
}

/// The native installers, per tool. `~/.local/bin` is Claude Code's and
/// Codex's; `~/.opencode/bin` is where OpenCode's install script puts itself
/// and is tried before it.
const KNOWN: &[Known] = &[
    Known {
        name: CLAUDE,
        not_found: CLAUDE_NOT_FOUND,
        home_dirs: &[".local/bin"],
    },
    Known {
        name: CODEX,
        not_found: CODEX_NOT_FOUND,
        home_dirs: &[".local/bin"],
    },
    Known {
        name: OPENCODE,
        not_found: OPENCODE_NOT_FOUND,
        home_dirs: &[".opencode/bin", ".local/bin"],
    },
];

/// The prefixes shared by every tool: Homebrew's two — Apple silicon, then
/// Intel — which is also where a `npm install -g` on a Homebrew node lands.
const SHARED_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// `~/.local/bin` for anything this app has no table entry for. A pane running
/// `AgentType::Custom` can name any program at all, and the two steps above
/// this one are the ones that matter for it; this is a courtesy.
const DEFAULT_HOME_DIRS: &[&str] = &[".local/bin"];

fn known(name: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|cli| cli.name == name)
}

/// The sentence shown when `name` could not be found anywhere.
///
/// The three tools get their own install instruction because that is the whole
/// value of the message; anything else gets the half of it that is still true.
fn not_found_message(name: &str) -> String {
    match known(name) {
        Some(cli) => cli.not_found.to_string(),
        None => format!(
            "`{name}` was not found on your PATH. Set {} to its full path, \
             or give the agent an absolute path in its custom arguments.",
            env_key(name)
        ),
    }
}

/// The environment override for `name`: `ROCSPACE_CLAUDE_BIN`,
/// `ROCSPACE_CODEX_BIN`, and so on.
///
/// The escape hatch named in every not-found message above — a user whose
/// binary is somewhere none of the three steps will find points at it with
/// this, and every test in this file uses it. Anything that is not an ASCII
/// alphanumeric becomes an underscore, so a hyphenated program name is still a
/// legal variable name.
fn env_key(name: &str) -> String {
    let mut key = String::with_capacity(name.len() + 13);
    key.push_str("ROCSPACE_");
    for ch in name.chars() {
        key.push(if ch.is_ascii_alphanumeric() {
            ch.to_ascii_uppercase()
        } else {
            '_'
        });
    }
    key.push_str("_BIN");
    key
}

/// The override, read fresh every time rather than cached: it is what tests set
/// per case, and a cached first read would make every case after the first one
/// run the wrong binary.
pub(crate) fn env_binary(key: &str) -> Option<PathBuf> {
    let raw = std::env::var(key).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// How long any one shell probe may take. A `~/.zshrc` with plugins in it is
/// slow, not broken; a `~/.zshrc` that blocks on a prompt or a dead network
/// mount is broken, and would otherwise hang the first launch for ever.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the probe wakes to ask whether the shell is done.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The most of a chatty shell's stdout one probe will read. The answer is one
/// line; a `~/.zshrc` that prints a megabyte of banner is not going to be
/// improved by keeping all of it.
const MAX_PROBE_BYTES: usize = 64 * 1024;

/// Everything a resolution is allowed to look at.
///
/// Passed in rather than read from the process inside each step, so the tests
/// can point the whole chain at a temp directory — asserting the ORDER without
/// a `claude`, a shell profile or a home directory of their own, and without
/// mutating the environment of a test binary that runs its cases in parallel.
struct ResolveEnv {
    /// This process's PATH — what an app launched from Finder actually got.
    path: Option<std::ffi::OsString>,
    /// The user's own shell, to ask about the PATH this process did NOT get.
    shell: Option<PathBuf>,
    /// `$HOME`, for the install locations that live under it.
    home: Option<PathBuf>,
}

impl ResolveEnv {
    fn from_process() -> Self {
        Self {
            path: std::env::var_os("PATH"),
            shell: user_shell(),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
}

/// The shell whose startup files the user actually edits.
///
/// `$SHELL` when there is one — and under launchd there very often is not: a
/// packaged app launched from Finder or restarted by the OS inherits an
/// environment with no SHELL in it at all. The old fallback was `/bin/bash`,
/// which on any macOS since Catalina is not the user's shell, has not sourced
/// their `~/.zshrc` and never will. `getpwuid` answers with the shell the
/// account record names — the one Terminal.app opens.
#[cfg(unix)]
pub(crate) fn user_shell() -> Option<PathBuf> {
    if let Some(shell) = std::env::var_os("SHELL") {
        if !shell.is_empty() {
            return Some(PathBuf::from(shell));
        }
    }
    passwd_shell()
}

#[cfg(not(unix))]
pub(crate) fn user_shell() -> Option<PathBuf> {
    // There is no login shell to ask; the process PATH is what Windows gives an
    // application, and `which` reads it (plus PATHEXT).
    None
}

/// The `pw_shell` field of this user's passwd record.
#[cfg(unix)]
fn passwd_shell() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 1024];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: `getpwuid_r` fills the caller's own record and buffer (the
    // reentrant form, so no static is shared with another thread), and reports
    // through `found` whether it wrote anything. The `CStr` below is read while
    // `buf` is still alive and is copied out of before it is dropped.
    let code = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut record,
            buf.as_mut_ptr(),
            buf.len(),
            &mut found,
        )
    };
    if code != 0 || found.is_null() || record.pw_shell.is_null() {
        return None;
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(record.pw_shell) }.to_bytes();
    if bytes.is_empty() {
        return None;
    }
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

/// `name` on the PATH this process was actually given.
fn on_process_path(name: &str, env: &ResolveEnv) -> Option<PathBuf> {
    let path = env.path.as_ref()?;
    // `which_in` rather than `which`: the PATH being searched is the one in
    // `env`, which is the process's own in production and a temp directory in
    // the tests. The cwd only matters for a PATH entry that is relative, which
    // is a PATH nobody has.
    which::which_in(name, Some(path), std::env::temp_dir()).ok()
}

/// Ask the user's own shell, INTERACTIVELY, where `name` is.
///
/// The `i` is the fix. `-lc` is a LOGIN shell, and a login shell sources
/// `~/.zprofile` / `~/.bash_profile` — while `~/.zshrc`, which only an
/// INTERACTIVE shell reads, is where the Claude Code native installer writes its
/// PATH line, where nvm/fnm/volta write theirs, and where `brew shellenv`
/// usually ends up. A packaged app that asked `-lc` therefore answered "CLI not
/// found" for the single most common way `claude` is installed, on a machine
/// where typing `claude` in Terminal works perfectly.
///
/// Which flags, and in which order, is `ask_interactively`'s business — this
/// question and `shell_env`'s ask it the same way.
///
/// `command -v` rather than `which` because it is a builtin every POSIX shell
/// has. The name IS interpolated into the script — a `Custom` pane can be
/// configured with any program name at all — so it is single-quoted on the way
/// in, and the quoting is what the hostile-name test asserts.
fn interactive_shell_path(name: &str, env: &ResolveEnv) -> Option<PathBuf> {
    let shell = env.shell.as_deref()?;
    let script = format!("command -v {}", posix_single_quote(name));
    ask_interactively(shell, &script, MAX_PROBE_BYTES, |stdout| {
        last_existing_path(&String::from_utf8_lossy(stdout))
    })
}

/// Wrap `s` in single quotes for POSIX `sh -c`, escaping embedded quotes the
/// only way single-quoted strings allow: close, escaped quote, reopen.
fn posix_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Run `script` in `shell`, INTERACTIVELY, and read the answer out of its
/// stdout with `parse`.
///
/// `-lic` first and `-ic` after it, because both halves earn their place: `-l`
/// picks up a value set only in a profile, and a shell whose profile exits
/// non-zero (or refuses to be a login shell at all) still answers `-ic`. A
/// `parse` that returns `None` is what makes the second attempt happen, so the
/// fallback covers "the shell ran but said nothing usable" as well as "the
/// shell would not start" — an interactive `-l` that dies inside `~/.zprofile`
/// still exits 0 often enough for the distinction to matter.
///
/// `max_bytes` is per caller because the two questions asked through here have
/// answers of very different sizes; see `MAX_PROBE_BYTES` and
/// `shell_env::MAX_PROBE_BYTES`.
pub(crate) fn ask_interactively<T>(
    shell: &Path,
    script: &str,
    max_bytes: usize,
    parse: impl Fn(&[u8]) -> Option<T>,
) -> Option<T> {
    ask_shell(shell, "-lic", script, max_bytes, &parse)
        .or_else(|| ask_shell(shell, "-ic", script, max_bytes, &parse))
}

fn ask_shell<T>(
    shell: &Path,
    flags: &str,
    script: &str,
    max_bytes: usize,
    parse: impl Fn(&[u8]) -> Option<T>,
) -> Option<T> {
    let child = Command::new(shell)
        .arg(flags)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Nulled rather than piped: an interactive shell's complaints are not
        // an answer, and a pipe nobody drains is a shell blocked writing into
        // it — which is the probe hanging on a `~/.zshrc` that is merely noisy.
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = capped_output(child, SHELL_PROBE_TIMEOUT, max_bytes)?;
    parse(&stdout)
}

/// `child`'s stdout, if it exits successfully inside `limit`.
///
/// Deliberately not `roc_brain`'s `wait_capped`: that one is about a model turn
/// (two pipes, a megabyte of answer, a failure worth quoting back). This is a
/// question whose only interesting answers are "here" and "no".
fn capped_output(mut child: Child, limit: Duration, max_bytes: usize) -> Option<Vec<u8>> {
    let mut pipe = child.stdout.take()?;
    // On its own thread, and draining past the cap, for the reason every read
    // in this app does: stopping at the cap and walking away leaves the shell
    // blocked writing into a full pipe, which turns a chatty profile into a
    // hang.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut pipe).take(max_bytes as u64).read_to_end(&mut buf);
        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        buf
    });

    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status.success().then(|| reader.join().unwrap_or_default());
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The reader is LEFT RUNNING rather than joined, the same
            // discipline (and for the same reason) as `roc_brain::wait_capped`:
            // killing a shell does not close a pipe its own children inherited,
            // so joining here would sit on a grandchild for as long as it felt
            // like living — a timeout that does not time out.
            drop(reader);
            return None;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// The answer in what an interactive shell said.
///
/// The LAST line that is a file, rather than the first line at all. An
/// interactive shell is chatty — a fortune, a version notice, a "Last login"
/// banner — and all of that lands on stdout above the one line we asked for. It
/// also disqualifies the other way `command -v` can answer: a shell function or
/// alias called `claude` comes back as a name rather than a path, and running a
/// name that is not a file is how you exec something else entirely.
fn last_existing_path(text: &str) -> Option<PathBuf> {
    text.lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// Where `name` puts itself, in the order a machine is likely to have it.
///
/// The tool's own installer first, then the shared prefixes. Last resort by
/// construction: it is guessing, and it only runs when neither the process nor
/// the user's own shell could say.
fn well_known_paths(name: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let dirs = known(name).map_or(DEFAULT_HOME_DIRS, |cli| cli.home_dirs);
    let mut paths = Vec::with_capacity(dirs.len() + SHARED_DIRS.len());
    if let Some(home) = home {
        for dir in dirs {
            let full = dir
                .split('/')
                .fold(home.to_path_buf(), |path, part| path.join(part));
            paths.push(full.join(name));
        }
    }
    paths.extend(SHARED_DIRS.iter().map(|dir| Path::new(dir).join(name)));
    paths
}

fn well_known(name: &str, env: &ResolveEnv) -> Option<PathBuf> {
    well_known_paths(name, env.home.as_deref())
        .into_iter()
        .find(|path| path.is_file())
}

/// The three places, in order.
fn resolve_in(name: &str, env: &ResolveEnv) -> Option<PathBuf> {
    on_process_path(name, env)
        .or_else(|| interactive_shell_path(name, env))
        .or_else(|| well_known(name, env))
}

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------

/// The binaries this process has found, remembered by name.
///
/// A `Vec` rather than a map because it holds one entry per agent CLI the user
/// has actually launched — three, on a busy day — and `Mutex::new(Vec::new())`
/// is a const initialiser where a `HashMap`'s is not.
///
/// **Hits only.** A remembered miss would mean a user who takes the advice in
/// the not-found message — install Claude Code, it is one command — has to
/// restart RocSpace before the app will admit it worked, and "quit and reopen
/// it" is not an answer to "I did what you said". Re-running the chain after a
/// miss costs a shell start on a press the user has to make anyway.
static RESOLVED: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// Remember a HIT for the life of the process, and never a miss.
///
/// The lock is not held across `resolve`: it runs a shell, twice, with a
/// ten-second cap on each — and a second caller blocked on that would be a
/// window frozen behind somebody else's `~/.zshrc`. Two callers racing a miss
/// both resolve and both record the same answer, which costs a shell start and
/// a duplicate entry nobody can tell apart from the original.
fn remembered_or(
    cache: &Mutex<Vec<(String, PathBuf)>>,
    name: &str,
    resolve: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    let remembered = cache
        .lock()
        .iter()
        .find(|(cached, _)| cached == name)
        .map(|(_, path)| path.clone());
    if let Some(found) = remembered {
        return Some(found);
    }
    let found = resolve()?;
    cache.lock().push((name.to_string(), found.clone()));
    Some(found)
}

/// The absolute path this process will exec for `name`, or the sentence to show
/// the user.
pub fn resolve(name: &str) -> Result<PathBuf, String> {
    if let Some(path) = env_binary(&env_key(name)) {
        return Ok(path);
    }
    remembered_or(&RESOLVED, name, || {
        resolve_in(name, &ResolveEnv::from_process())
    })
    .ok_or_else(|| not_found_message(name))
}

/// Resolve `name` in the background, so the first pane that needs it does not
/// pay for the shell probe.
///
/// `terminal_spawn` is a SYNCHRONOUS Tauri command, which means it runs on the
/// main thread — and on a packaged app, where step 1 always misses, resolving
/// there costs the length of a `zsh -lic`. That is a window that does not paint
/// for as long as the user's `~/.zshrc` takes, on the click that opens their
/// first pane. Started at setup instead, it is warm long before then; the cache
/// makes the pane's own call free, and a race between the two only costs a
/// second shell start.
pub fn warm(name: &'static str) {
    std::thread::spawn(move || {
        let _ = resolve(name);
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[cfg(unix)]
    fn resolve_env(path: Option<&Path>, shell: Option<&Path>, home: Option<&Path>) -> ResolveEnv {
        ResolveEnv {
            path: path.map(|p| p.as_os_str().to_os_string()),
            shell: shell.map(Path::to_path_buf),
            home: home.map(Path::to_path_buf),
        }
    }

    #[cfg(unix)]
    fn same_file(a: &Path, b: &Path) -> bool {
        std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok()
    }

    /// A shell that records the flags it was asked with, and answers with
    /// whatever `answer` is — the noise line included, because an interactive
    /// shell prints one and the answer is not the first thing on stdout.
    #[cfg(unix)]
    fn shell_stub(dir: &Path, log: &Path, answer: &str) -> PathBuf {
        stub(
            dir,
            "shell",
            &format!("printf '%s\\n' \"$1\" >> '{}'\n{answer}", log.display()),
        )
    }

    /// An empty directory, to stand in for the PATH a Finder-launched app got.
    #[cfg(unix)]
    fn empty_dir(tmp: &TempDir) -> PathBuf {
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        empty
    }

    // -- the order --------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn the_process_path_is_tried_first_and_no_shell_is_asked() {
        let tmp = TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let claude = stub(&bin, "claude", "exit 0");
        let asked = tmp.path().join("asked");
        let shell = shell_stub(tmp.path(), &asked, "exit 1");

        let found = resolve_in(CLAUDE, &resolve_env(Some(&bin), Some(&shell), None)).unwrap();

        assert!(same_file(&found, &claude), "got: {}", found.display());
        assert!(
            !asked.exists(),
            "a shell was started for a binary already on this process's PATH"
        );
    }

    /// The finding this whole chain exists for: `~/.zshrc` is where the Claude
    /// Code installer and every node version manager put their PATH line, and
    /// only an INTERACTIVE shell reads it.
    #[cfg(unix)]
    #[test]
    fn asks_an_interactive_login_shell_when_the_process_path_has_none() {
        let tmp = TempDir::new().unwrap();
        let empty = empty_dir(&tmp);
        let claude = stub(tmp.path(), "claude", "exit 0");
        let asked = tmp.path().join("asked");
        let shell = shell_stub(
            tmp.path(),
            &asked,
            &format!(
                "printf 'Last login: Tue\\n'\nprintf '%s\\n' '{}'",
                claude.display()
            ),
        );

        let found = resolve_in(CLAUDE, &resolve_env(Some(&empty), Some(&shell), None)).unwrap();

        assert!(same_file(&found, &claude), "got: {}", found.display());
        assert_eq!(std::fs::read_to_string(&asked).unwrap(), "-lic\n");
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_a_plain_interactive_shell_when_the_login_one_fails() {
        let tmp = TempDir::new().unwrap();
        let empty = empty_dir(&tmp);
        let claude = stub(tmp.path(), "claude", "exit 0");
        let asked = tmp.path().join("asked");
        let shell = shell_stub(
            tmp.path(),
            &asked,
            &format!(
                "if [ \"$1\" = '-lic' ]; then exit 1; fi\nprintf '%s\\n' '{}'",
                claude.display()
            ),
        );

        let found = resolve_in(CLAUDE, &resolve_env(Some(&empty), Some(&shell), None)).unwrap();

        assert!(same_file(&found, &claude), "got: {}", found.display());
        assert_eq!(std::fs::read_to_string(&asked).unwrap(), "-lic\n-ic\n");
    }

    /// `command -v` answers a shell function or alias with a NAME. Running one
    /// of those would exec whatever is called that on the PATH we already know
    /// does not have `claude` on it.
    #[cfg(unix)]
    #[test]
    fn a_shell_answer_that_is_not_a_file_is_not_taken() {
        let tmp = TempDir::new().unwrap();
        let empty = empty_dir(&tmp);
        let asked = tmp.path().join("asked");
        let shell = shell_stub(tmp.path(), &asked, "printf 'claude\\n'");

        assert!(resolve_in(CLAUDE, &resolve_env(Some(&empty), Some(&shell), None)).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_a_well_known_location_when_no_shell_can_say() {
        let tmp = TempDir::new().unwrap();
        let empty = empty_dir(&tmp);
        let local_bin = tmp.path().join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        let claude = stub(&local_bin, "claude", "exit 0");
        let asked = tmp.path().join("asked");
        let shell = shell_stub(tmp.path(), &asked, "exit 1");

        let found =
            resolve_in(CLAUDE, &resolve_env(Some(&empty), Some(&shell), Some(tmp.path()))).unwrap();

        assert!(same_file(&found, &claude), "got: {}", found.display());
        // …and only after both shell attempts had their say.
        assert_eq!(std::fs::read_to_string(&asked).unwrap(), "-lic\n-ic\n");
    }

    #[cfg(unix)]
    #[test]
    fn nothing_anywhere_is_a_miss_rather_than_a_guess() {
        let tmp = TempDir::new().unwrap();
        let empty = empty_dir(&tmp);
        let asked = tmp.path().join("asked");
        let shell = shell_stub(tmp.path(), &asked, "exit 1");

        assert!(resolve_in(CLAUDE, &resolve_env(Some(&empty), Some(&shell), Some(&empty))).is_none());
    }

    /// Everything the packaged app is: the PATH Finder hands it, no `$SHELL`
    /// answer worth having, and a `claude` sitting where its installer put it.
    /// The resolution has to be ABSOLUTE, because a bare name is what the PTY
    /// could not run.
    #[cfg(unix)]
    #[test]
    fn a_finder_launched_path_still_finds_every_agent_cli() {
        let tmp = TempDir::new().unwrap();
        // `/usr/bin:/bin:/usr/sbin:/sbin`, as measured from a running `.app`:
        // none of the three CLIs is ever in one of those.
        let empty = empty_dir(&tmp);
        let asked = tmp.path().join("asked");
        let shell = shell_stub(tmp.path(), &asked, "exit 1");
        let local_bin = tmp.path().join(".local").join("bin");
        let opencode_bin = tmp.path().join(".opencode").join("bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        std::fs::create_dir_all(&opencode_bin).unwrap();
        stub(&local_bin, CLAUDE, "exit 0");
        stub(&local_bin, CODEX, "exit 0");
        stub(&opencode_bin, OPENCODE, "exit 0");

        for name in [CLAUDE, CODEX, OPENCODE] {
            let found =
                resolve_in(name, &resolve_env(Some(&empty), Some(&shell), Some(tmp.path())))
                    .unwrap_or_else(|| panic!("{name} was not found"));
            assert!(found.is_absolute(), "{name}: {}", found.display());
            assert!(found.ends_with(name), "{name}: {}", found.display());
        }
    }

    /// A `Custom` pane's program is free text from the Inspector, and it is the
    /// one thing from outside this file that reaches the probe's shell script.
    /// Quoted, it is a name the shell cannot find; unquoted — or naively
    /// quoted — it is a command the shell runs.
    ///
    /// Both shapes, because they break different mistakes: the first needs no
    /// quoting at all to escape, the second escapes anything that wraps the
    /// name in quotes without escaping the quotes inside it.
    #[cfg(unix)]
    #[test]
    fn a_hostile_program_name_cannot_run_a_second_command() {
        for shape in ["x; touch {}", "x'; touch '{}"] {
            let tmp = TempDir::new().unwrap();
            let empty = empty_dir(&tmp);
            let ran = tmp.path().join("ran");
            // A real `sh`, so the injection would actually happen if it could.
            let shell = stub(tmp.path(), "shell", "exec /bin/sh \"$@\"");
            let hostile = shape.replace("{}", &ran.display().to_string());

            let found =
                resolve_in(&hostile, &resolve_env(Some(&empty), Some(&shell), Some(&empty)));

            assert!(found.is_none(), "{hostile}: got {found:?}");
            assert!(!ran.exists(), "{hostile} was executed as a command");
        }
    }

    // -- where the tools install themselves -------------------------------

    #[test]
    fn the_well_known_paths_are_where_claude_installs_itself() {
        assert_eq!(
            well_known_paths(CLAUDE, Some(Path::new("/Users/someone"))),
            vec![
                PathBuf::from("/Users/someone/.local/bin/claude"),
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ]
        );
        // No home to ask about is not a reason to skip the absolute ones.
        assert_eq!(well_known_paths(CLAUDE, None).len(), 2);
    }

    #[test]
    fn opencodes_own_installer_directory_comes_first() {
        assert_eq!(
            well_known_paths(OPENCODE, Some(Path::new("/Users/someone"))),
            vec![
                PathBuf::from("/Users/someone/.opencode/bin/opencode"),
                PathBuf::from("/Users/someone/.local/bin/opencode"),
                PathBuf::from("/opt/homebrew/bin/opencode"),
                PathBuf::from("/usr/local/bin/opencode"),
            ]
        );
    }

    #[test]
    fn a_program_nobody_has_a_table_entry_for_still_gets_the_usual_places() {
        assert_eq!(
            well_known_paths("my-agent", Some(Path::new("/Users/someone"))),
            vec![
                PathBuf::from("/Users/someone/.local/bin/my-agent"),
                PathBuf::from("/opt/homebrew/bin/my-agent"),
                PathBuf::from("/usr/local/bin/my-agent"),
            ]
        );
    }

    // -- the messages -----------------------------------------------------

    #[test]
    fn every_known_cli_is_named_with_the_command_that_installs_it() {
        for (name, expected) in [
            (CLAUDE, CLAUDE_NOT_FOUND),
            (CODEX, CODEX_NOT_FOUND),
            (OPENCODE, OPENCODE_NOT_FOUND),
        ] {
            let message = not_found_message(name);
            assert_eq!(message, expected);
            assert!(message.contains("not found"), "{name}: {message}");
            assert!(message.contains(&env_key(name)), "{name}: {message}");
        }
    }

    #[test]
    fn an_unknown_program_is_still_told_how_to_be_pointed_at() {
        let message = not_found_message("my-agent");
        assert!(message.contains("my-agent"), "got: {message}");
        assert!(message.contains("ROCSPACE_MY_AGENT_BIN"), "got: {message}");
    }

    #[test]
    fn the_override_variable_is_the_one_the_message_names() {
        assert_eq!(env_key(CLAUDE), "ROCSPACE_CLAUDE_BIN");
        assert_eq!(env_key(CODEX), "ROCSPACE_CODEX_BIN");
        assert_eq!(env_key(OPENCODE), "ROCSPACE_OPENCODE_BIN");
        // A hyphen is not legal in a variable name; an underscore is.
        assert_eq!(env_key("my-agent"), "ROCSPACE_MY_AGENT_BIN");
    }

    // -- remembering ------------------------------------------------------

    /// A user who reads "install Claude Code", installs it, and starts a pane
    /// again must be answered — not told to restart the app. So a HIT is
    /// remembered and a MISS is not.
    #[test]
    fn a_miss_is_never_remembered_and_a_hit_always_is() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let cache: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());
        let tries = AtomicU64::new(0);
        let miss = || {
            tries.fetch_add(1, Ordering::SeqCst);
            None
        };

        assert!(remembered_or(&cache, CLAUDE, miss).is_none());
        assert!(remembered_or(&cache, CLAUDE, miss).is_none());
        assert_eq!(
            tries.load(Ordering::SeqCst),
            2,
            "the miss was remembered — installing claude would need a restart"
        );

        let installed = PathBuf::from("/somewhere/claude");
        let first = remembered_or(&cache, CLAUDE, || Some(installed.clone())).unwrap();
        assert_eq!(first, installed);
        let second =
            remembered_or(&cache, CLAUDE, || panic!("the hit was not remembered")).unwrap();
        assert_eq!(second, installed);
    }

    #[test]
    fn one_cli_being_remembered_does_not_answer_for_another() {
        let cache: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());
        let claude = PathBuf::from("/somewhere/claude");
        let codex = PathBuf::from("/elsewhere/codex");

        remembered_or(&cache, CLAUDE, || Some(claude.clone()));

        assert_eq!(
            remembered_or(&cache, CODEX, || Some(codex.clone())),
            Some(codex)
        );
        assert_eq!(
            remembered_or(&cache, CLAUDE, || panic!("resolved twice")),
            Some(claude)
        );
    }

    // -- the override -----------------------------------------------------

    #[test]
    fn a_blank_override_is_not_an_override() {
        // Set by a launcher that exports every variable it knows about,
        // empty. Treating it as a path would exec "".
        assert!(env_binary("ROCSPACE_A_VARIABLE_NOBODY_HAS_SET").is_none());
    }
}
