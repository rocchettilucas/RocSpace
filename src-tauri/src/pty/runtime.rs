//! Real PTY runtime backed by portable-pty.
//!
//! Spawns a shell or agent CLI in a pseudo-terminal, streams its output bytes
//! to the renderer as `terminal://output` events, accepts input bytes via the
//! `terminal_write` command, and supports resize + kill.
//!
//! Threading model:
//!   - portable-pty's reader/writer/child are blocking. We use std::thread::spawn
//!     (NOT tokio::spawn) for the output pump so the tokio runtime stays free for
//!     async work. The writer is held in a Mutex and called synchronously from
//!     command handlers.
//!   - On Windows, ConPTY backs portable-pty automatically. On macOS/Linux it uses
//!     /dev/ptmx. No platform-specific code paths needed here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter};

use crate::agents::command::{
    launch_spec, mcp_binary_path, rocplan_project, ClaudeSession, LaunchSpec, RocPlanServer,
};
use crate::agents::events_path;
use crate::models::{AgentConfig, AgentType, OutputStream, SpawnResult, TerminalStatus};

use crate::pty::events::{TerminalOutputEvent, TerminalStatusEvent, EVENT_OUTPUT, EVENT_STATUS};
use crate::pty::utf8::Utf8Stream;

/// One running PTY session. Owns the pieces needed to write to it and shut it down.
struct PtySession {
    /// Writer half of the master PTY. Wrapped in Mutex so multiple input commands
    /// can safely interleave (rare in practice, but cheap to guard).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Master half — we keep it alive (and use it for resize) for the lifetime of
    /// the session. Dropping it closes the slave end and signals the child.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Child process handle. Kept so we can kill on demand.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Claude Code `--session-id` handed to this child, when it is a Claude
    /// pane. This doubles as the session→terminal registry the hook tailer
    /// needs: the mapping lives on the session itself, so it cannot outlive the
    /// PTY or drift out of sync with it — `kill` drops both together.
    claude_session_id: Option<String>,
}

/// Per-terminal spawn counter. Tells an exit waiter whether the PTY it was born
/// watching is still the one the terminal owns.
///
/// `spawn` kills the previous child before starting the replacement, but the
/// waiter watching that child is a separate thread polling `try_wait` every
/// 150 ms, and it is keyed on nothing but the terminal id. It reaps the child
/// it was told to watch, sees a signal death rather than a clean exit, and
/// emits `terminal://status = error` — over the healthy process that has
/// already taken the pane over. The new reader's one-shot `running` normally
/// beat it there, so a restarted shell or codex pane simply latched red.
///
/// Every spawn claims the next generation for its terminal *before* killing
/// the process it replaces, so the old waiter is already stale by the time its
/// child can be reaped. A waiter whose generation is no longer current stays
/// silent and exits.
#[derive(Default)]
struct SpawnGenerations(Mutex<HashMap<String, u64>>);

impl SpawnGenerations {
    /// Claim the next generation for `terminal_id`.
    fn claim(&self, terminal_id: &str) -> u64 {
        let mut map = self.0.lock().expect("pty generations mutex poisoned");
        let slot = map.entry(terminal_id.to_string()).or_insert(0);
        *slot += 1;
        *slot
    }

    /// True while `generation` is still the terminal's newest spawn — i.e.
    /// while a waiter born at that generation is allowed to speak for the pane.
    ///
    /// A terminal with no generation at all has never been spawned through this
    /// runtime, so nobody may speak for it.
    fn still_current(&self, terminal_id: &str, generation: u64) -> bool {
        let map = self.0.lock().expect("pty generations mutex poisoned");
        map.get(terminal_id).copied() == Some(generation)
    }

    fn clear(&self) {
        self.0
            .lock()
            .expect("pty generations mutex poisoned")
            .clear();
    }
}

#[derive(Default)]
pub struct PtyRuntime {
    sessions: Mutex<HashMap<String, PtySession>>,
    /// Shared with every exit waiter this runtime starts. Deliberately not
    /// pruned by `kill`: `spawn` claims the next generation *before* killing
    /// the old child, so a prune there would erase the claim that silences the
    /// waiter it is racing. One `u64` per terminal id spawned this run.
    generations: Arc<SpawnGenerations>,
}

impl PtyRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new PTY for `terminal_id`. If one already exists, kill it first
    /// so callers can use this as "restart".
    ///
    /// The whole `AgentConfig` comes in (not just the type) because the launch
    /// argv is derived from it — model, permissions, task prompt and custom
    /// args all reach the CLI from here.
    ///
    /// `resume_claude_session` is a conversation uuid the renderer wants this
    /// pane to rejoin (a pane that was mid-conversation when the app quit, or a
    /// restored saved session). Given one, the pane keeps that uuid and the CLI
    /// is launched with `--resume`; given none, a fresh uuid is minted and the
    /// CLI gets `--session-id`. Either way the uuid comes back in the
    /// `SpawnResult` and is what the hook tailer resolves this terminal by.
    pub fn spawn(
        &self,
        app: AppHandle,
        terminal_id: String,
        config: AgentConfig,
        cwd: Option<String>,
        resume_claude_session: Option<String>,
        size: Option<(u16, u16)>,
    ) -> Result<SpawnResult, String> {
        // Everything the launch is made of, worked out BEFORE this spawn
        // touches the terminal it is replacing. Resolving the agent binary can
        // fail (it is not installed), and a restart that killed the running
        // pane and then reported "Claude Code CLI not found" would have cost
        // the user the session they still had.
        //
        // For agent terminals we spawn the user's shell wrapped around an
        // inline command that clears the screen, then hands the PTY off to
        // the agent CLI. That way the user sees ONLY the agent — no shell
        // prompt and no echoed `claude` / `codex` / `opencode` command above
        // it. An agent that isn't installed is caught below, before any of
        // that: the pane is never started, and the failure says so.
        // Plain Shell terminals (and Custom ones with nothing configured) get
        // a normal interactive shell — `launch_spec` returns None for those.
        //
        // Which conversation this pane is actually going to be in — see
        // `conversation_for`, which is also where a `--resume` at a
        // conversation that no longer exists stops being fatal.
        let conversation = conversation_for(
            config.agent_type,
            resume_claude_session,
            crate::agents::transcript::conversation_lost,
        );
        // The pane's cwd is its project directory, which is also the board the
        // RocPlan MCP server should serve. Resolved here rather than inside
        // `launch_spec` so that stays a pure function: finding the server means
        // `current_exe` and a `stat`.
        let cwd = cwd.filter(|dir| !dir.trim().is_empty());
        let mcp_binary = mcp_binary_path();
        let rocplan = match (rocplan_project(cwd.as_deref()), mcp_binary.as_deref()) {
            (Some(project_path), Some(binary)) => Some(RocPlanServer {
                binary,
                project_path,
            }),
            // No usable project directory, or no server binary beside the app:
            // the pane launches without the board's tools rather than with a
            // config Claude Code would report as a broken server on every start.
            _ => None,
        };
        // …and the binary the spec names is turned into an absolute path here,
        // for the same reason and by the same rule: `LaunchSpec::resolved`
        // documents the trap, `cli_binary` is the chain, and a miss is the
        // typed sentence that tells the user how to fix it — which reaches
        // Settings › History through this function's `Err`, rather than
        // flashing `command not found` in a pane that then dies.
        let spec = launch_spec(&config, conversation.session(), &events_path(), rocplan)
            .map(|spec| spec.resolved(crate::cli_binary::resolve))
            .transpose()?;
        // Only report the uuid when it was actually handed to a CLI. Reporting
        // it for a codex/shell pane would make the renderer treat that pane as
        // hook-driven and silence its fallback status heuristic.
        let claude_session_id = match (config.agent_type, spec.is_some()) {
            (AgentType::ClaudeCode, true) => Some(conversation.uuid.clone()),
            _ => None,
        };

        // Also before the kill: this can wait (briefly, and only in the app's
        // first seconds) for the shell probe, and a restart that killed the
        // running pane and then sat there would be the worst of both.
        let cmd = build_command(
            spec.as_ref(),
            cwd.as_deref(),
            &crate::shell_env::for_children(),
        );

        // Claim this spawn's generation before the kill below. That kill is
        // what lets the outgoing child be reaped, so the claim has to land
        // first for its waiter to be reliably stale by then.
        let generation = self.generations.claim(&terminal_id);
        // Kill any existing session for this id first.
        let _ = self.kill(&terminal_id);

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            // Born at the size the pane is ALREADY showing, not at a default
            // the caller then has to correct. A TUI reads its width once at
            // startup and draws for it; a PTY opened at 80x24 inside a 55-column
            // pane makes the agent wrap its own UI, and the resize that would
            // have fixed it is dropped when it arrives before this line runs.
            .openpty(PtySize {
                rows: size.map(|(_, rows)| rows).unwrap_or(24),
                cols: size.map(|(cols, _)| cols).unwrap_or(80),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        let pid = child.process_id();

        // Drop the slave; the child holds it open via fd inheritance. Keeping the
        // slave around in this process can cause hangs on some platforms.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader: {e}"))?;

        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
            claude_session_id: claude_session_id.clone(),
        };

        let child_for_waiter = session.child.clone();
        self.sessions
            .lock()
            .expect("pty sessions mutex poisoned")
            .insert(terminal_id.clone(), session);

        // Pump output → events on a dedicated OS thread (blocking I/O).
        spawn_reader(app.clone(), terminal_id.clone(), reader);
        // Watch the child for exit on another thread, then emit a status event.
        spawn_waiter(
            app,
            terminal_id.clone(),
            child_for_waiter,
            self.generations.clone(),
            generation,
        );

        Ok(SpawnResult {
            pid,
            claude_session_id,
            conversation_lost: conversation.lost,
        })
    }

    /// Which terminal owns the Claude Code session `session_uuid`, if any.
    ///
    /// This is the session→terminal lookup the hook tailer needs. It reads the
    /// live PTY map directly rather than a parallel registry, so a killed
    /// terminal stops resolving the moment its session is dropped and there is
    /// no second structure to keep clean. Linear over at most
    /// `LIMITS.terminalsPerProfile` sessions, called at most a few times a
    /// second.
    pub fn terminal_for_claude_session(&self, session_uuid: &str) -> Option<String> {
        let sessions = self.sessions.lock().expect("pty sessions mutex poisoned");
        sessions.iter().find_map(|(terminal_id, session)| {
            (session.claude_session_id.as_deref() == Some(session_uuid))
                .then(|| terminal_id.clone())
        })
    }

    /// True while at least one Claude Code session is alive. The tailer uses it
    /// to decide when truncating the events file is safe.
    pub fn has_live_claude_sessions(&self) -> bool {
        let sessions = self.sessions.lock().expect("pty sessions mutex poisoned");
        sessions.values().any(|s| s.claude_session_id.is_some())
    }

    /// Write bytes from the renderer (xterm.onData) into the PTY's stdin.
    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .expect("pty sessions mutex poisoned");
        let Some(session) = sessions.get(terminal_id) else {
            return Err(format!("no PTY for terminal {terminal_id}"));
        };
        let mut writer = session
            .writer
            .lock()
            .expect("pty writer mutex poisoned");
        writer
            .write_all(data)
            .map_err(|e| format!("write: {e}"))?;
        writer.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    /// Resize the PTY when the renderer's xterm fits to its container.
    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .expect("pty sessions mutex poisoned");
        let Some(session) = sessions.get(terminal_id) else {
            return Err(format!("no PTY for terminal {terminal_id}"));
        };
        let master = session
            .master
            .lock()
            .expect("pty master mutex poisoned");
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {e}"))
    }

    /// Terminate the PTY's child process and drop the session.
    pub fn kill(&self, terminal_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("pty sessions mutex poisoned");
        let Some(session) = sessions.remove(terminal_id) else {
            return Ok(()); // no-op if not running
        };
        let mut child = session
            .child
            .lock()
            .expect("pty child mutex poisoned");
        let _ = child.kill();
        Ok(())
    }

    /// Best-effort shutdown for app exit. Wired to `RunEvent::ExitRequested` /
    /// `RunEvent::Exit` in `lib.rs` so quitting RocSpace never leaves orphaned
    /// shells or agent CLIs behind.
    pub fn kill_all(&self) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("pty sessions mutex poisoned");
        for (_, session) in sessions.drain() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
        self.generations.clear();
    }
}

/// Which Claude Code conversation a spawn is actually going to be in.
struct Conversation {
    /// The uuid the CLI is handed: the one that was asked for on a resume, a
    /// freshly minted one otherwise.
    uuid: String,
    /// Whether that uuid names a conversation to REJOIN (`--resume`) or one to
    /// CREATE (`--session-id`). The two flags are mutually exclusive on the
    /// CLI; see `agents::command::ClaudeSession`.
    resuming: bool,
    /// A resume was asked for, and the conversation it named is gone. The pane
    /// is starting a fresh conversation instead, and the renderer is told so it
    /// can say what happened.
    lost: bool,
}

impl Conversation {
    fn session(&self) -> ClaudeSession<'_> {
        if self.resuming {
            ClaudeSession::Resume(&self.uuid)
        } else {
            ClaudeSession::New(&self.uuid)
        }
    }
}

/// Decide it.
///
/// A resume keeps the conversation's own uuid — that is what makes it the same
/// conversation — so only a fresh spawn mints one. A blank string is treated as
/// "no resume": it reaches here from JSON, where an empty field and a missing
/// one are the same intent.
///
/// And a resume whose conversation is GONE is turned into a fresh spawn rather
/// than being sent to the CLI to fail. That is the finding: a session the user
/// never sent a turn in leaves no transcript, `claude --resume <uuid>` answers
/// "No conversation found with session ID" and exits, and the pane it was
/// launched into is dead seconds after the app opened — four panes out of four,
/// on the machine this was measured on, every time RocSpace was quit with
/// agents open but un-prompted. The pane is worth more than the uuid.
///
/// `lost` is passed in (it is `agents::transcript::conversation_lost`, which
/// reads the user's transcript directory) so this stays a decision a test can
/// make without one.
///
/// Only ever asked about a Claude Code pane. No other CLI is handed a uuid, so
/// for those a stray one is not a resume that failed — it is a value that was
/// never going to be used, and reporting it as a lost conversation would be
/// noise about nothing.
fn conversation_for(
    agent_type: AgentType,
    requested: Option<String>,
    lost: impl FnOnce(&str) -> bool,
) -> Conversation {
    let requested = requested.filter(|uuid| !uuid.trim().is_empty());
    let lost = matches!(agent_type, AgentType::ClaudeCode)
        && requested.as_deref().is_some_and(lost);
    match requested.filter(|_| !lost) {
        Some(uuid) => Conversation {
            uuid,
            resuming: true,
            lost: false,
        },
        None => Conversation {
            uuid: uuid::Uuid::new_v4().to_string(),
            resuming: false,
            lost,
        },
    }
}

/// Everything the PTY child is: what to run, where, and in whose environment.
///
/// `login_env` is the user's own shell environment, captured once by
/// `shell_env`. It exists because a Finder-launched `.app` is given
/// `PATH=/usr/bin:/bin:/usr/sbin:/sbin` by launchd, `CommandBuilder::new` seeds
/// the child from this process's own variables, and `$SHELL -c` is not
/// interactive — so without this the agent CLI runs in a development
/// environment with no `node`, no `pnpm` and nothing Homebrew ever installed.
/// The plain Shell pane gets it too: its `$SHELL -l` on a PTY *is* interactive
/// and does re-read `~/.zshrc`, but on top of a PATH that started crippled,
/// which is only as good as what that file happens to prepend.
///
/// The order of the three steps is the contract:
///
///   1. The builder starts from this process's environment. Nothing is cleared,
///      so an empty or failed capture leaves the child exactly as it was —
///      never with an empty PATH.
///   2. The capture goes on top, key by key. It is the user's answer to "what
///      would my terminal have given this?", and where the two disagree it
///      wins.
///   3. What RocSpace knows about THIS pane goes on top of that, so nothing
///      read out of a shell can contradict the terminal the child is actually
///      attached to. `shell_env` also refuses to carry these, which makes the
///      rule true twice rather than only by being written last.
///
/// Split out from `spawn` so it can be tested: a `CommandBuilder` answers
/// `get_env`, and a real PTY spawned from one answers for the child.
fn build_command(
    spec: Option<&LaunchSpec>,
    cwd: Option<&str>,
    login_env: &[(String, String)],
) -> CommandBuilder {
    let mut cmd = match spec {
        Some(spec) => shell_launching_agent(spec),
        None => default_shell(),
    };
    for (key, value) in login_env {
        cmd.env(key, value);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

fn spawn_reader(
    app: AppHandle,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut seq: usize = 0;
        let mut started = false;
        // Read boundaries fall wherever the kernel buffer ended, which is
        // regularly inside a multi-byte character. `Utf8Stream` carries that
        // tail into the next read instead of replacing it; see `pty::utf8`.
        let mut decoder = Utf8Stream::new();
        let emit_text = |text: String, seq: &mut usize| {
            if text.is_empty() {
                return;
            }
            let line_id = format!("pty_{}_{}", terminal_id, seq);
            *seq += 1;
            let _ = app.emit(
                EVENT_OUTPUT,
                &TerminalOutputEvent {
                    terminal_id: terminal_id.clone(),
                    line_id,
                    ts: now_ms(),
                    stream: OutputStream::Stdout,
                    text,
                },
            );
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !started {
                        started = true;
                        let _ = app.emit(
                            EVENT_STATUS,
                            &TerminalStatusEvent {
                                terminal_id: terminal_id.clone(),
                                status: TerminalStatus::Running,
                            },
                        );
                    }
                    emit_text(decoder.decode(&buf[..n]), &mut seq);
                }
                Err(e) => {
                    eprintln!("[pty {}] read error: {}", terminal_id, e);
                    break;
                }
            }
        }
        // The stream is over, so a held-back partial character will never be
        // completed. Emitting it lossily beats swallowing it.
        emit_text(decoder.flush(), &mut seq);
    });
}

/// Watch one child for exit and report it — but only while this spawn is still
/// the terminal's current one. `generation` is what a restart invalidates; see
/// `SpawnGenerations` for the race it closes.
fn spawn_waiter(
    app: AppHandle,
    terminal_id: String,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    generations: Arc<SpawnGenerations>,
    generation: u64,
) {
    // Poll with try_wait so we yield the child mutex between checks. Holding the
    // lock across a blocking wait() would deadlock with kill(), which also needs
    // mutable access to the same Child.
    std::thread::spawn(move || {
        // This exit belongs to a PTY the terminal has already replaced; the
        // pane is showing a different process now, so say nothing about it.
        let emit = |status: TerminalStatus| {
            if !generations.still_current(&terminal_id, generation) {
                return;
            }
            let _ = app.emit(
                EVENT_STATUS,
                &TerminalStatusEvent {
                    terminal_id: terminal_id.clone(),
                    status,
                },
            );
        };
        loop {
            let result = match child.lock() {
                Ok(mut guard) => guard.try_wait(),
                Err(_) => return,
            };
            match result {
                Ok(Some(status)) => {
                    emit(if status.success() {
                        TerminalStatus::Complete
                    } else {
                        TerminalStatus::Error
                    });
                    return;
                }
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(_) => {
                    emit(TerminalStatus::Error);
                    return;
                }
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn default_shell() -> CommandBuilder {
    // Prefer PowerShell 7 (`pwsh`) — falls through to Windows PowerShell or cmd
    // if it's not on PATH. portable-pty resolves via PATH automatically.
    if which::which("pwsh.exe").is_ok() {
        CommandBuilder::new("pwsh.exe")
    } else if which::which("powershell.exe").is_ok() {
        CommandBuilder::new("powershell.exe")
    } else {
        CommandBuilder::new("cmd.exe")
    }
}

/// The user's shell, asked the way `cli_binary` asks it.
///
/// Not `env::var("SHELL")`: a Finder-launched app is handed an environment with
/// no `SHELL` in it, so that read fails in exactly the build a user installs and
/// nowhere else. The old fallback then ran `/bin/bash`, which on any macOS since
/// Catalina is not the user's shell — their aliases, functions and prompt all
/// silently absent from a pane that looks like their terminal. `user_shell`
/// falls back to the account record, which names the shell Terminal.app opens.
#[cfg(not(target_os = "windows"))]
fn login_shell() -> std::ffi::OsString {
    crate::cli_binary::user_shell()
        .map(std::path::PathBuf::into_os_string)
        .unwrap_or_else(|| "/bin/bash".into())
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> CommandBuilder {
    let mut cmd = CommandBuilder::new(login_shell());
    // -l makes login shells source rc files; harmless for non-login.
    cmd.arg("-l");
    cmd
}

/// Build a shell command that clears the screen and hands the PTY off to the
/// agent CLI described by `spec`. Used so the user never sees a shell prompt or
/// an echoed launch command — the pane boots straight into the agent.
///
/// The argv is re-quoted for the shell rather than interpolated raw: a task
/// prompt is arbitrary user text and reaches this string verbatim, so anything
/// less would be a command-injection hole (`agent_launch_name`, which this
/// replaces, only ever interpolated hard-coded binary names).
#[cfg(not(target_os = "windows"))]
fn shell_launching_agent(spec: &LaunchSpec) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(login_shell());
    cmd.arg("-c");
    cmd.arg(agent_shell_line(spec));
    cmd
}

/// The whole of what `$SHELL -c` is asked to run.
///
/// exec replaces the shell process with the agent so it inherits the PTY
/// directly and we don't burn a fork. clear wipes any inherited contents.
///
/// Split out from the `CommandBuilder` so a test can read the line: `-c` is a
/// NON-interactive shell, which is what makes the program having been resolved
/// to an absolute path (`LaunchSpec::resolved`) load-bearing rather than
/// tidy — and an absolute path is the one that can contain a space.
#[cfg(not(target_os = "windows"))]
fn agent_shell_line(spec: &LaunchSpec) -> String {
    format!("clear; exec {}", posix_command_line(spec))
}

/// `program arg arg` with POSIX shell quoting applied to every word.
#[cfg(not(target_os = "windows"))]
fn posix_command_line(spec: &LaunchSpec) -> String {
    let words = std::iter::once(spec.program.as_str()).chain(spec.args.iter().map(String::as_str));
    shell_words::join(words)
}

#[cfg(target_os = "windows")]
fn shell_launching_agent(spec: &LaunchSpec) -> CommandBuilder {
    // pwsh / powershell: `Clear-Host; & <name> <args>` — `&` is the call
    // operator, and the call inherits the parent's stdio so the PTY reaches the
    // agent.
    let line = powershell_command_line(spec);
    if which::which("pwsh.exe").is_ok() {
        let mut cmd = CommandBuilder::new("pwsh.exe");
        cmd.arg("-NoLogo");
        cmd.arg("-Command");
        cmd.arg(format!("Clear-Host; {line}"));
        cmd
    } else if which::which("powershell.exe").is_ok() {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd.arg("-Command");
        cmd.arg(format!("Clear-Host; {line}"));
        cmd
    } else {
        // cmd.exe has no usable quoting story for arbitrary text; double quotes
        // plus escaped inner quotes is the best available and this branch only
        // runs on machines without any PowerShell at all.
        let mut line = spec.program.clone();
        for arg in &spec.args {
            line.push(' ');
            line.push_str(&format!("\"{}\"", arg.replace('"', "\\\"")));
        }
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/C");
        cmd.arg(format!("cls && {line}"));
        cmd
    }
}

/// `& 'program' 'arg' 'arg'` with PowerShell single-quote escaping (a literal
/// quote is written by doubling it).
#[cfg(target_os = "windows")]
fn powershell_command_line(spec: &LaunchSpec) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let mut line = format!("& {}", quote(&spec.program));
    for arg in &spec.args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The restart race, exercised without a real PTY: `SpawnGenerations` is the
/// whole gate, so testing it is testing whether a stale waiter can speak.
#[cfg(test)]
mod spawn_generation_tests {
    use super::*;

    #[test]
    fn the_first_spawns_waiter_may_report_its_exit() {
        let gens = SpawnGenerations::default();
        let g1 = gens.claim("t1");
        assert!(gens.still_current("t1", g1));
    }

    #[test]
    fn a_restart_silences_the_previous_spawns_waiter() {
        // The bug: restart kills the old child, the old waiter reaps it, sees
        // a signal death and shouts `error` over the new healthy process.
        let gens = SpawnGenerations::default();
        let old = gens.claim("t1");
        let new = gens.claim("t1");

        assert!(
            !gens.still_current("t1", old),
            "the stale waiter stays quiet"
        );
        assert!(gens.still_current("t1", new), "the live one still reports");
    }

    #[test]
    fn many_restarts_leave_only_the_newest_waiter_speaking() {
        let gens = SpawnGenerations::default();
        let generations: Vec<u64> = (0..5).map(|_| gens.claim("t1")).collect();
        let (newest, stale) = generations.split_last().expect("five spawns");
        for g in stale {
            assert!(!gens.still_current("t1", *g), "generation {g} is stale");
        }
        assert!(gens.still_current("t1", *newest));
    }

    #[test]
    fn restarting_one_terminal_does_not_silence_another() {
        let gens = SpawnGenerations::default();
        let a = gens.claim("t1");
        let b = gens.claim("t2");
        gens.claim("t1");

        assert!(!gens.still_current("t1", a));
        assert!(gens.still_current("t2", b), "t2 was never restarted");
    }

    #[test]
    fn a_terminal_that_never_spawned_has_nobody_to_speak_for_it() {
        let gens = SpawnGenerations::default();
        assert!(!gens.still_current("never-spawned", 1));
    }

    #[test]
    fn killing_a_terminal_never_silences_its_own_waiter() {
        // Only `spawn` claims a generation. `terminal_kill` must not, or the
        // exit it causes would be swallowed and a killed pane would sit on
        // `running` forever.
        let runtime = PtyRuntime::new();
        let g = runtime.generations.claim("t1");
        runtime
            .kill("t1")
            .expect("killing an unknown terminal is a no-op");
        assert!(runtime.generations.still_current("t1", g));
    }

    #[test]
    fn clearing_at_shutdown_silences_everyone() {
        let gens = SpawnGenerations::default();
        let g = gens.claim("t1");
        gens.clear();
        assert!(!gens.still_current("t1", g));
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn spec(args: &[&str]) -> LaunchSpec {
        LaunchSpec {
            program: "claude".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// A Finder-launched `.app` is handed an environment with no `SHELL` in it.
    /// The old code read `env::var("SHELL")` here and fell back to `/bin/bash`,
    /// so the shipped app opened panes in a shell the user does not use — none
    /// of their aliases, functions or prompt — while every terminal-launched
    /// dev build inherited `SHELL` and looked perfectly correct.
    #[test]
    #[cfg(unix)]
    fn a_pane_uses_the_account_shell_when_the_environment_names_none() {
        // SAFETY: single-threaded assertion on process state, restored below.
        let saved = std::env::var_os("SHELL");
        unsafe { std::env::remove_var("SHELL") };

        let chosen = login_shell();

        if let Some(prev) = saved {
            unsafe { std::env::set_var("SHELL", prev) };
        }

        // Whatever the account record says, it is answered — and it is not the
        // blind `/bin/bash` guess, unless that genuinely IS the account shell.
        let expected = crate::cli_binary::user_shell()
            .map(std::path::PathBuf::into_os_string)
            .expect("the account record names a shell on any real unix");
        assert_eq!(chosen, expected);
    }

    #[test]
    fn simple_args_are_passed_through_unquoted() {
        assert_eq!(
            posix_command_line(&spec(&["--model", "opus"])),
            "claude --model opus"
        );
    }

    #[test]
    fn a_task_prompt_with_spaces_stays_one_argument() {
        let line = posix_command_line(&spec(&["ship the thing"]));
        assert_eq!(line, "claude 'ship the thing'");
    }

    #[test]
    fn a_task_prompt_cannot_break_out_into_a_second_command() {
        // The prompt is arbitrary user text; interpolating it raw would run
        // `rm -rf /` the moment someone pasted this into the Inspector. The
        // escaped form still *contains* those characters — what matters is that
        // the shell reads them as one word, so assert on the split, not the
        // substring.
        let hostile = "'; rm -rf / #";
        let line = posix_command_line(&spec(&[hostile]));
        assert_eq!(line, r#"claude ''\''; rm -rf / #'"#);
        assert_eq!(
            shell_words::split(&line).expect("re-splittable"),
            vec!["claude", hostile]
        );
    }

    #[test]
    fn settings_json_survives_quoting_intact() {
        let json = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}"#;
        let line = posix_command_line(&spec(&["--settings", json]));
        // shell-words is the inverse of the shell's own splitting, so round
        // tripping proves the CLI sees exactly what we built.
        let parsed = shell_words::split(&line).expect("re-splittable");
        assert_eq!(parsed, vec!["claude", "--settings", json]);
    }

    // -- what the shell is actually asked to run ---------------------------
    //
    // `-c` is not interactive, so nothing on this line gets a second chance at
    // finding the program: whatever `LaunchSpec::resolved` put there is what
    // `exec` is handed.

    #[test]
    fn the_agent_line_execs_the_absolute_path_the_spec_carries() {
        let resolved = spec(&["--session-id", "abc"])
            .resolved(|name| Ok(PathBuf::from(format!("/Users/roc/.local/bin/{name}"))))
            .expect("resolvable");

        assert_eq!(
            agent_shell_line(&resolved),
            "clear; exec /Users/roc/.local/bin/claude --session-id abc"
        );
    }

    #[test]
    fn an_install_path_with_a_space_stays_one_word() {
        // `/Applications/My Tools/claude` is an ordinary macOS install
        // location, and this line is read by a shell. Unquoted it would exec
        // `/Applications/My` with `Tools/claude` as its first argument — the
        // same failure `custom_spec` was fixed for, one layer down.
        let resolved = spec(&["--model", "opus"])
            .resolved(|_| Ok(PathBuf::from("/Applications/My Tools/claude")))
            .expect("resolvable");

        let line = agent_shell_line(&resolved);
        assert_eq!(
            line,
            "clear; exec '/Applications/My Tools/claude' --model opus"
        );
        assert_eq!(
            shell_words::split(&line).expect("re-splittable"),
            vec![
                "clear;",
                "exec",
                "/Applications/My Tools/claude",
                "--model",
                "opus"
            ]
        );
    }

    // -- which conversation a pane starts in --------------------------------
    //
    // The bug these cover: RocSpace persisted a uuid its own SessionStart hook
    // reported, handed it back as `--resume` on the next launch, and the CLI
    // answered "No conversation found with session ID" and exited — because a
    // session with no turn in it leaves no conversation. The pane died with it.

    const UUID: &str = "9b7dce75-d3db-451d-9aea-187aa433aeb6";

    fn claude() -> AgentConfig {
        AgentConfig {
            agent_type: AgentType::ClaudeCode,
            task_prompt: None,
            model: None,
            permissions: crate::models::PermissionSettings::default(),
            custom_args: None,
        }
    }

    fn gone(_: &str) -> bool {
        true
    }

    fn still_there(_: &str) -> bool {
        false
    }

    #[test]
    fn a_resume_whose_conversation_still_exists_is_still_a_resume() {
        let conversation = conversation_for(
            AgentType::ClaudeCode,
            Some(UUID.to_string()),
            still_there,
        );

        assert_eq!(conversation.uuid, UUID);
        assert!(conversation.resuming);
        assert!(!conversation.lost);
    }

    /// The fix. The pane keeps its life; the uuid is the thing that goes.
    #[test]
    fn a_resume_whose_conversation_is_gone_starts_a_fresh_one() {
        let conversation =
            conversation_for(AgentType::ClaudeCode, Some(UUID.to_string()), gone);

        assert!(!conversation.resuming, "still tried to resume it");
        assert_ne!(conversation.uuid, UUID, "kept a uuid with nothing behind it");
        assert!(
            conversation.lost,
            "started fresh without saying the conversation was lost"
        );
    }

    /// …all the way to the argv, because `--resume` and `--session-id` are the
    /// two flags this decision exists to choose between.
    #[test]
    fn a_lost_conversation_reaches_the_cli_as_session_id_not_resume() {
        let conversation =
            conversation_for(AgentType::ClaudeCode, Some(UUID.to_string()), gone);

        let spec = launch_spec(
            &claude(),
            conversation.session(),
            std::path::Path::new("/tmp/rocspace-events.jsonl"),
            None,
        )
        .expect("a claude pane has a launch spec");

        assert_eq!(spec.args.first().map(String::as_str), Some("--session-id"));
        assert!(
            !spec.args.iter().any(|arg| arg == "--resume"),
            "got: {:?}",
            spec.args
        );
        assert!(!spec.args.iter().any(|arg| arg == UUID), "got: {:?}", spec.args);
    }

    #[test]
    fn a_pane_that_was_not_asked_to_resume_anything_mints_a_uuid() {
        for requested in [None, Some(String::new()), Some("   ".to_string())] {
            let conversation = conversation_for(AgentType::ClaudeCode, requested, |_| {
                panic!("asked about a conversation nobody named")
            });

            assert!(!conversation.resuming);
            assert!(!conversation.lost, "nothing was lost — nothing was asked for");
            assert_eq!(conversation.uuid.len(), UUID.len(), "a fresh uuid");
        }
    }

    /// No other CLI is handed a uuid, so a stray one on a codex or shell pane
    /// is not a resume that failed.
    #[test]
    fn only_a_claude_pane_can_lose_a_conversation() {
        for agent_type in [AgentType::Codex, AgentType::OpenCode, AgentType::Shell] {
            let conversation = conversation_for(agent_type, Some(UUID.to_string()), |_| {
                panic!("{agent_type:?} was asked about a claude conversation")
            });

            assert!(!conversation.lost);
        }
    }

    // -- the environment the child runs in ---------------------------------
    //
    // The packaged app's whole problem in one line: launchd gives it
    // `/usr/bin:/bin:/usr/sbin:/sbin`, `CommandBuilder::new` copies that into
    // the child, and `$SHELL -c` is not interactive so nothing puts it back.
    // What is asserted here is that the CAPTURE REACHES THE CHILD — the probe
    // answering correctly is `shell_env`'s business.

    fn captured(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_captured_path_is_what_the_child_will_be_given() {
        let cmd = build_command(
            Some(&spec(&[])),
            None,
            &captured(&[("PATH", "/opt/homebrew/bin:/usr/bin")]),
        );

        assert_eq!(
            cmd.get_env("PATH"),
            Some(std::ffi::OsStr::new("/opt/homebrew/bin:/usr/bin"))
        );
    }

    /// The graceful degradation, and the one failure mode that would be worse
    /// than the bug: a probe that could not answer must leave the child with
    /// what it already had, never with nothing.
    #[test]
    fn nothing_captured_leaves_the_process_environment_untouched() {
        let cmd = build_command(Some(&spec(&[])), None, &[]);

        assert_eq!(
            cmd.get_env("PATH").map(|p| p.to_string_lossy().into_owned()),
            std::env::var("PATH").ok(),
            "an empty capture cleared the child's PATH"
        );
    }

    /// `TERM` describes the xterm this pane is drawn into. The probe's shell
    /// had a pipe for stdout and knows nothing about it.
    #[test]
    fn a_captured_terminal_cannot_contradict_the_pane() {
        let cmd = build_command(
            Some(&spec(&[])),
            None,
            &captured(&[("TERM", "dumb"), ("COLORTERM", "")]),
        );

        assert_eq!(cmd.get_env("TERM"), Some(std::ffi::OsStr::new("xterm-256color")));
        assert_eq!(cmd.get_env("COLORTERM"), Some(std::ffi::OsStr::new("truecolor")));
    }

    /// The plain Shell pane is still a plain login shell — the capture is
    /// added to it, not in place of it.
    #[test]
    fn a_shell_pane_is_still_a_login_shell_with_the_environment_on_top() {
        let cmd = build_command(None, None, &captured(&[("PATH", "/opt/homebrew/bin")]));

        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|word| word.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv.len(), 2, "got: {argv:?}");
        assert_eq!(argv[1], "-l");
        assert_eq!(
            cmd.get_env("PATH"),
            Some(std::ffi::OsStr::new("/opt/homebrew/bin"))
        );
    }

    /// The end of the chain, through a real pty: what the process on the other
    /// side of it actually has in `$PATH`.
    #[test]
    fn the_captured_environment_reaches_a_real_child() {
        const SENTINEL: &str = "/rocspace-captured/bin";
        // Printed through the same `$SHELL -c 'clear; exec …'` line every agent
        // pane is launched with, because that line is where the environment
        // used to be lost.
        let echo = LaunchSpec {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "printf '<<%s>>' \"$PATH\"".to_string(),
            ],
        };
        let cmd = build_command(
            Some(&echo),
            None,
            &captured(&[("PATH", &format!("{SENTINEL}:/usr/bin:/bin"))]),
        );

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");

        // On a thread with a channel, because a pty read blocks: a child that
        // said nothing must fail this test, not hang the suite.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
                if seen.windows(2).any(|pair| pair == b">>") {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&seen).into_owned());
        });
        let printed = rx
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("the child printed its PATH");
        let _ = child.kill();

        assert!(
            printed.contains(SENTINEL),
            "the child's PATH did not carry the capture: {printed:?}"
        );
    }

    #[test]
    fn a_pane_whose_agent_is_not_installed_is_never_started() {
        // The typed sentence, not a shell's `command not found` in a pane that
        // then dies — `PtyRuntime::spawn` returns this to the renderer, which
        // files it under Settings › History.
        let err = spec(&[])
            .resolved(|_| Err(crate::cli_binary::CLAUDE_NOT_FOUND.to_string()))
            .unwrap_err();

        assert!(err.contains("not found"), "got: {err}");
    }
}
