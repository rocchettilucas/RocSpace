//! The environment a pane's process would have had if the user had started it
//! themselves.
//!
//! **The finding.** A `.app` launched from Finder is started by launchd, and
//! launchd hands it `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — nothing else. The
//! PTY runtime spawns `$SHELL -c 'clear; exec <agent> …'`, and portable-pty's
//! `CommandBuilder::new` seeds the child from `std::env::vars_os()`, so that
//! four-entry PATH is what the agent CLI gets. `-c` is NOT interactive: `zsh`
//! reads `~/.zshenv` and stops, so nothing on the way in restores it. Measured
//! inside a pane of the packaged app on this machine:
//!
//! ```text
//! PATH=/Users/dev/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin
//!   node MISSING   npm MISSING   pnpm MISSING
//!   git /usr/bin/git   python3 /usr/bin/python3
//! ```
//!
//! `cli_binary` already fixed the first casualty — the agent binary itself, by
//! resolving it to an absolute path. This module fixes the layer out from that,
//! which is the one that actually matters: RocSpace is an agentic development
//! environment, and an agent that cannot see `node`, `pnpm`, or anything
//! Homebrew or a version manager installed cannot run the user's tests, build
//! or scripts. It fails constantly, confusingly, and ONLY in the installed app —
//! a developer running `pnpm tauri:dev` from a terminal never sees any of it,
//! because that process already inherited a full shell environment.
//!
//! **The mechanism.** Ask the user's own shell, once, what its environment is,
//! and give that to every PTY child. The alternative — launch each pane through
//! `$SHELL -lic` instead of `-c` — was rejected: it pays for the whole of
//! `~/.zshrc` on every single pane spawn, inherits whatever side effects it has
//! (a `set -x`, an instant-prompt banner, a plugin manager that self-updates),
//! and leaves the shell interactive underneath the agent, which is a job-control
//! and terminal-mode relationship nobody asked for. One shell, at startup, is
//! cheaper and quieter, and the answer is reusable.
//!
//! **The probe.** `printf` a marker, dump the environment, `printf` a marker.
//! Everything about that shape is deliberate:
//!
//!   * **The markers** are how the answer is found in a chatty shell's stdout.
//!     An interactive shell prints banners, version notices and "Last login"
//!     lines, and a `~/.zshrc` with `set -x` in it prints its own source. Only
//!     what lies between the two markers is read — and output that stops before
//!     the closing marker (a shell killed at the timeout, a dump that hit the
//!     byte cap) has no closing marker, so a TRUNCATED capture is rejected
//!     rather than half-applied.
//!   * **`awk`** rather than `env`, because the records have to be NUL
//!     separated. macOS's `env` has no `-0`, and newline-separated output is
//!     ambiguous for any variable whose value contains a newline. POSIX awk's
//!     `ENVIRON` is on every unix, and `printf "%c", 0` writes the separator.
//!   * **Bare `awk`**, not `/usr/bin/awk`: by the time it runs, the shell has
//!     sourced its startup files and has a real PATH, and the binary is in
//!     different places on macOS and Linux.
//!
//! **Bounded, always.** `terminal_spawn` is a synchronous Tauri command, so it
//! runs on the MAIN thread — a probe that hangs there is a frozen window, not a
//! slow pane. So: `warm()` at setup runs it on a thread of its own,
//! `cli_binary`'s ten-second cap kills a shell that will not exit, and a pane
//! that somehow arrives before the answer waits `READY_WAIT` and then starts
//! WITHOUT it. Failing that way is the old behaviour, which is survivable;
//! wedging the window is not.
//!
//! **Never an empty PATH.** Nothing here ever clears the child's environment.
//! The capture is applied over what the process already had, key by key, so a
//! probe that fails, times out, or comes back empty leaves the child exactly
//! where it was.

use std::path::Path;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// How long a pane may wait for the probe before starting without it.
///
/// Measured from when the probe STARTED, not from when the pane asked, so this
/// is a bound on the app's first couple of seconds rather than a toll every
/// spawn pays: a probe still running at the deadline is left running, and every
/// pane after it returns immediately (with nothing, until the probe lands).
///
/// `warm()` runs at `setup()`, and the window has to load, hydrate a snapshot
/// and lay out a workspace before it can ask for a pane — hundreds of
/// milliseconds against a probe that takes tens. In practice this never
/// elapses; it exists for the `~/.zshrc` that takes ten seconds to decide.
const READY_WAIT: Duration = Duration::from_secs(2);

/// The most of a shell's stdout one environment probe will read.
///
/// Four times `cli_binary`'s, because the answer is four hundred times bigger:
/// a real environment is 5-10 KB here, and a shell that exports build flags or
/// bash functions can be far larger. A dump that does not fit is rejected whole
/// (the closing marker never arrives), so this is the point at which a captured
/// environment turns back into no captured environment.
const MAX_PROBE_BYTES: usize = 256 * 1024;

/// What the probe prints on either side of the dump. Long and prefixed because
/// they have to be findable in whatever else the shell decided to say, and must
/// not collide with a real value.
const BEGIN_MARKER: &str = "__ROCSPACE_ENV_BEGIN__";
const END_MARKER: &str = "__ROCSPACE_ENV_END__";

/// Variables the captured environment must NOT carry into a pane.
///
/// Every one of these describes the PROBE — a shell RocSpace started, in a
/// directory it did not choose, with no terminal — and describing the pane
/// wrongly is worse than not describing it at all:
///
///   * `PWD` / `OLDPWD` name the probe's working directory (`/` under
///     launchd). The pane sets its own cwd, and a shell that trusts a stale
///     `PWD` reports the wrong directory to everything that asks it.
///   * `SHLVL` and `_` are bookkeeping about a process that has already exited.
///   * `TERM` / `COLORTERM` are RocSpace's to set: they describe the xterm the
///     pane is drawn into, which the probe (`stdout` on a pipe) is not.
///   * `LINES` / `COLUMNS`, when a user exports them, are a terminal size — and
///     a TUI that believes them draws itself for somebody else's window.
///
/// The pane's own values for these are applied after the capture anyway, so
/// this list is belt and braces; it is written down because "the captured
/// environment wins" is otherwise the obvious reading of the code.
const NOT_INHERITED: &[&str] = &[
    "PWD", "OLDPWD", "SHLVL", "_", "TERM", "COLORTERM", "LINES", "COLUMNS",
];

// ---------------------------------------------------------------------------
// The one capture
// ---------------------------------------------------------------------------

/// The probe's state, for the life of the process.
///
/// A settled MISS is remembered, which is the opposite of `cli_binary`'s
/// hits-only rule, and the difference is the cost of being wrong. There, a
/// forgotten miss costs one shell start on a press the user was making anyway,
/// and remembering it would mean "install Claude Code, then restart the app".
/// Here, a forgotten miss costs a shell start ON THE MAIN THREAD for every pane
/// the user ever opens — and the miss that matters is a `~/.zshrc` that hangs,
/// so the bill is `READY_WAIT` per pane, for ever. Nothing the user does
/// mid-session fixes a broken rc file either.
struct Probe {
    /// When the probe was started, or `None` before anything started it.
    started: Option<Instant>,
    /// Whether the answer below is final.
    settled: bool,
    /// The captured pairs. Empty until settled, and empty forever if the probe
    /// could not answer.
    env: Vec<(String, String)>,
}

static PROBE: Mutex<Probe> = Mutex::new(Probe {
    started: None,
    settled: false,
    env: Vec::new(),
});

/// Capture the user's shell environment in the background, so the first pane
/// does not pay for it.
///
/// Called from `setup()`. Idempotent — the second call is a lock and a
/// comparison — and safe to race with `for_children`, which starts the probe
/// itself if nothing has yet.
pub fn warm() {
    let _ = begin();
}

/// Make sure the probe is running, and answer when it started.
fn begin() -> Instant {
    let mut probe = PROBE.lock();
    if let Some(started) = probe.started {
        return started;
    }
    let started = Instant::now();
    probe.started = Some(started);
    // Dropped before the thread is spawned, not because the thread wants the
    // lock immediately — it wants it a shell later — but so that a panic
    // between here and there cannot leave it held.
    drop(probe);
    std::thread::spawn(|| {
        let captured = capture().unwrap_or_default();
        let mut probe = PROBE.lock();
        probe.env = captured;
        probe.settled = true;
    });
    started
}

/// The environment to give a PTY child, over whatever this process already has.
///
/// Empty means "nothing to add" — the probe failed, or has not landed yet — and
/// the caller must treat it as exactly that, never as an environment to replace
/// the child's with.
pub fn for_children() -> Vec<(String, String)> {
    let deadline = begin() + READY_WAIT;
    loop {
        {
            let probe = PROBE.lock();
            if probe.settled {
                return probe.env.clone();
            }
        }
        if Instant::now() >= deadline {
            return Vec::new();
        }
        std::thread::sleep(crate::cli_binary::POLL_INTERVAL);
    }
}

/// Ask the user's shell, once. `None` when there is no shell to ask, it could
/// not be started, or it did not answer in the shape this asked for.
fn capture() -> Option<Vec<(String, String)>> {
    let shell = crate::cli_binary::user_shell()?;
    let mut captured =
        crate::cli_binary::ask_interactively(&shell, &probe_script(), MAX_PROBE_BYTES, parse)?;
    with_shell(&mut captured, &shell);
    Some(captured)
}

/// Name the shell, if the dump did not.
///
/// It usually does not. `SHELL` is set by `login(1)` and by terminal emulators,
/// NOT by the shell itself — so a `zsh` started by an app that was started by
/// launchd exports no `SHELL` at all, and neither does the environment it hands
/// back. Measured: `zsh -lic 'printf "[%s]" "$SHELL"'` under a Finder-launched
/// environment prints `[]`.
///
/// It is worth filling in because the pane's contents ask: a tool that shells
/// out reads `$SHELL` to decide what to shell out TO, which is how an agent
/// ends up running the user's project scripts under `sh` on a machine where
/// everything is configured for `zsh`. This is the same shell the probe just
/// used, so the value is the one the user's own terminal would have set.
///
/// Only when it is missing. A `SHELL` the user really did export means it, and
/// this is not the place to overrule them.
fn with_shell(captured: &mut Vec<(String, String)>, shell: &Path) {
    if captured.iter().any(|(key, _)| key == "SHELL") {
        return;
    }
    if let Some(path) = shell.to_str() {
        captured.push(("SHELL".to_string(), path.to_string()));
    }
}

/// The line the user's shell is asked to run. See the module docs for why it is
/// shaped this way.
///
/// Built rather than written as one literal so the markers cannot drift from
/// the constants that look for them.
fn probe_script() -> String {
    format!(
        "printf '%s' '{BEGIN_MARKER}'; \
         awk 'BEGIN {{ for (k in ENVIRON) printf \"%s=%s%c\", k, ENVIRON[k], 0 }}'; \
         printf '%s' '{END_MARKER}'"
    )
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/// The variables in a probe's stdout, or `None` when it does not contain a
/// complete dump.
///
/// Order is the shell's own and is preserved, which matters for nothing except
/// making the tests readable.
fn parse(stdout: &[u8]) -> Option<Vec<(String, String)>> {
    let body = between(stdout, BEGIN_MARKER.as_bytes(), END_MARKER.as_bytes())?;
    let pairs = body
        .split(|byte| *byte == b'\0')
        .filter_map(one_pair)
        .filter(|(key, _)| !NOT_INHERITED.contains(&key.as_str()))
        .collect();
    Some(pairs)
}

/// The bytes between the first `begin` and the first `end` after it.
///
/// Both are required. Missing `begin` is a shell that never got as far as the
/// dump; missing `end` is a dump that was cut off — by the timeout, or by the
/// byte cap — and half an environment is not one worth giving a process.
fn between<'a>(haystack: &'a [u8], begin: &[u8], end: &[u8]) -> Option<&'a [u8]> {
    let opened = find(haystack, begin)? + begin.len();
    let rest = &haystack[opened..];
    Some(&rest[..find(rest, end)?])
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// One `KEY=value` record.
///
/// Split at the FIRST `=`, because a value may contain any number of them
/// (`LESS=-R --mouse`, a `GIT_CONFIG_PARAMETERS`), and a record with no `=` at
/// all is not one — that is awk's output being something other than what was
/// asked for, and it is dropped rather than guessed at.
///
/// Non-UTF-8 is dropped for the same reason. An environment variable can hold
/// arbitrary bytes, but every variable that matters here is a path or a flag,
/// and passing through a lossy re-encoding of one would hand the child a value
/// that is subtly not what the user's shell has.
fn one_pair(record: &[u8]) -> Option<(String, String)> {
    let at = record.iter().position(|byte| *byte == b'=')?;
    let key = std::str::from_utf8(&record[..at]).ok()?;
    if key.is_empty() {
        return None;
    }
    let value = std::str::from_utf8(&record[at + 1..]).ok()?;
    Some((key.to_string(), value.to_string()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A probe's stdout: `noise`, then a dump of `vars`, then the closing
    /// marker — the shape a real interactive shell produces.
    fn probe_output(noise: &str, vars: &[(&str, &str)]) -> Vec<u8> {
        let mut out = noise.as_bytes().to_vec();
        out.extend_from_slice(BEGIN_MARKER.as_bytes());
        for (key, value) in vars {
            out.extend_from_slice(format!("{key}={value}").as_bytes());
            out.push(0);
        }
        out.extend_from_slice(END_MARKER.as_bytes());
        out
    }

    fn value_of<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The whole point: a PATH the process was never given, read out of the
    /// user's own shell.
    #[test]
    fn the_path_is_read_out_of_a_chatty_shells_output() {
        // What an interactive `~/.zshrc` puts on stdout above the answer.
        let noise = "Last login: Tue Aug  5 09:12:44\n\u{1b}]0;roc\u{7}";
        let out = probe_output(noise, &[("PATH", "/opt/homebrew/bin:/usr/bin")]);

        let env = parse(&out).expect("a complete dump");

        assert_eq!(value_of(&env, "PATH"), Some("/opt/homebrew/bin:/usr/bin"));
    }

    #[test]
    fn a_value_containing_an_equals_sign_keeps_all_of_it() {
        let out = probe_output("", &[("LESS", "-R --tabs=4")]);
        let env = parse(&out).expect("a complete dump");
        assert_eq!(value_of(&env, "LESS"), Some("-R --tabs=4"));
    }

    /// The reason the records are NUL separated rather than newline separated.
    #[test]
    fn a_value_containing_a_newline_survives() {
        let out = probe_output("", &[("BANNER", "one\ntwo"), ("PATH", "/usr/bin")]);
        let env = parse(&out).expect("a complete dump");
        assert_eq!(value_of(&env, "BANNER"), Some("one\ntwo"));
        assert_eq!(value_of(&env, "PATH"), Some("/usr/bin"));
    }

    /// A shell killed at the timeout, or a dump past the byte cap: the closing
    /// marker never arrives, and half an environment is worse than none.
    #[test]
    fn a_truncated_dump_is_rejected_whole() {
        let mut out = probe_output("", &[("PATH", "/opt/homebrew/bin:/usr/bin")]);
        out.truncate(out.len() - END_MARKER.len() - 4);

        assert!(parse(&out).is_none());
    }

    #[test]
    fn a_shell_that_never_reached_the_dump_says_nothing() {
        assert!(parse(b"zsh: command not found: awk\n").is_none());
    }

    /// An empty environment is still a complete answer — it just has nothing in
    /// it. Distinguishing that from a failed probe costs nothing and keeps the
    /// caller's "empty means add nothing" rule honest either way.
    #[test]
    fn a_dump_with_nothing_in_it_is_still_a_dump() {
        assert_eq!(parse(&probe_output("", &[])), Some(Vec::new()));
    }

    #[test]
    fn the_probes_own_bookkeeping_is_not_inherited() {
        let out = probe_output(
            "",
            &[
                ("PWD", "/"),
                ("OLDPWD", "/"),
                ("SHLVL", "1"),
                ("_", "/usr/bin/awk"),
                ("TERM", "dumb"),
                ("COLORTERM", ""),
                ("LINES", "24"),
                ("COLUMNS", "80"),
                ("PATH", "/opt/homebrew/bin"),
            ],
        );

        let env = parse(&out).expect("a complete dump");

        assert_eq!(
            env,
            vec![("PATH".to_string(), "/opt/homebrew/bin".to_string())],
            "only the probe's own bookkeeping is dropped"
        );
    }

    /// Two records awk would never write — one with no `=`, one with an empty
    /// name — plus the trailing separator every dump ends with.
    #[test]
    fn a_record_that_is_not_a_variable_is_dropped_rather_than_guessed_at() {
        let mut out = BEGIN_MARKER.as_bytes().to_vec();
        out.extend_from_slice(b"PATH=/usr/bin\0nonsense\0=orphan\0");
        out.extend_from_slice(END_MARKER.as_bytes());

        let env = parse(&out).expect("a complete dump");

        assert_eq!(env, vec![("PATH".to_string(), "/usr/bin".to_string())]);
    }

    /// `SHELL` is set by `login(1)`, not by the shell — so the dump from a
    /// Finder-launched app has none, and a pane whose tools shell out would
    /// have had to guess.
    #[test]
    fn the_shell_that_was_asked_is_named_when_the_dump_does_not_name_one() {
        let mut captured = vec![("PATH".to_string(), "/usr/bin".to_string())];

        with_shell(&mut captured, Path::new("/bin/zsh"));

        assert_eq!(value_of(&captured, "SHELL"), Some("/bin/zsh"));
    }

    #[test]
    fn a_shell_the_user_really_did_export_is_left_alone() {
        let mut captured = vec![("SHELL".to_string(), "/opt/homebrew/bin/fish".to_string())];

        with_shell(&mut captured, Path::new("/bin/zsh"));

        assert_eq!(captured.len(), 1);
        assert_eq!(value_of(&captured, "SHELL"), Some("/opt/homebrew/bin/fish"));
    }

    #[test]
    fn the_probe_script_prints_both_markers_around_the_dump() {
        let script = probe_script();
        let begin = script.find(BEGIN_MARKER).expect("opening marker");
        let dump = script.find("ENVIRON").expect("the dump");
        let end = script.find(END_MARKER).expect("closing marker");
        assert!(begin < dump && dump < end, "got: {script}");
    }
}
