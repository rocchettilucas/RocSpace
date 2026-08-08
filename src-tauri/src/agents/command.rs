//! Agent launch specification — turns an `AgentConfig` into the concrete
//! program + argv that the PTY runtime should exec.
//!
//! This is the module that finally makes agent config *matter*: model,
//! permissions, task prompt and custom args used to be edited, persisted and
//! then thrown away at spawn time (`pty/runtime.rs` launched a bare
//! `claude` / `codex` / `opencode`).
//!
//! Pure and side-effect free on purpose: `launch_spec` builds a value, the
//! caller decides how to exec it. That keeps the whole mapping unit-testable
//! without spawning anything.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::models::{AgentConfig, AgentType, PermissionSettings};

/// A resolved launch: the binary to exec plus its argument vector, already
/// split into individual argv entries (NOT a shell string).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl LaunchSpec {
    /// `self` with a bare `program` replaced by the absolute path to run.
    ///
    /// The builders below name the CLIs the way a person types them —
    /// `claude`, `codex`, `opencode` — and a bare name is only a program if
    /// something on the way to `exec` can find it. Nothing can: `pty::runtime`
    /// hands the command line to `$SHELL -c`, which is NOT interactive, and
    /// every one of those CLIs installs its PATH line into a file only an
    /// interactive shell reads. In a packaged app (whose whole PATH is
    /// `/usr/bin:/bin:/usr/sbin:/sbin`) the pane's shell answered
    /// `command not found` and exited, which the pane reported as
    /// `status=error` a moment after wiping the message off the screen.
    ///
    /// The resolver is passed IN rather than called here so `launch_spec` and
    /// everything around it stays a pure function of its arguments: finding a
    /// binary means reading a PATH, `stat`ing files and starting a shell.
    /// `pty::runtime` passes `crate::cli_binary::resolve`; the tests pass a
    /// closure.
    ///
    /// A program that is already a path — `AgentType::Custom` configured with
    /// `/Applications/My Agent/bin/agent`, or a relative `./agent` — is left
    /// exactly as written. It is not a name to look up, and the user who typed
    /// it means that file.
    pub fn resolved(
        mut self,
        resolve: impl FnOnce(&str) -> Result<PathBuf, String>,
    ) -> Result<Self, String> {
        // One component and nothing else: `claude` is a name, `./claude`,
        // `bin/claude` and `/usr/bin/claude` are all paths. Asking `Path` this
        // way rather than looking for a separator keeps Windows' `C:claude`
        // (prefix + name) on the correct side of the line.
        if Path::new(&self.program).components().count() != 1 {
            return Ok(self);
        }
        // `to_string_lossy` because `LaunchSpec.program` is a `String` and a
        // path is not. Every install location any of these CLIs uses is UTF-8;
        // a path that is not would already be unspellable in the Inspector.
        self.program = resolve(&self.program)?.to_string_lossy().into_owned();
        Ok(self)
    }
}

/// The RocPlan MCP server a Claude pane should be given: where the binary is,
/// and which project it serves.
///
/// One value rather than two arguments because they are only ever useful
/// together — a server with no project has no board to open, and a project with
/// no server binary is a config entry pointing at nothing, which Claude Code
/// reports as a failed MCP server on every launch. `None` is the honest answer
/// to either half being missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RocPlanServer<'a> {
    pub binary: &'a Path,
    /// The pane's project directory, passed to the server as its only argument.
    pub project_path: &'a str,
}

/// The name the MCP config files the server under, and therefore the prefix
/// Claude Code puts on its tools. Part of the contract: the prompt a dispatched
/// card carries names `rocplan_update_task_status`.
const MCP_SERVER_KEY: &str = "rocplan";

/// Which conversation a Claude Code pane is starting, and therefore which flag
/// carries the uuid.
///
/// The two are mutually exclusive on the CLI — `--session-id` names a session
/// to CREATE, `--resume` names one to CONTINUE, and passing both is an error —
/// so this is an enum rather than an extra argument that could be set alongside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeSession<'a> {
    /// A fresh conversation under a uuid we just minted: `--session-id <uuid>`.
    New(&'a str),
    /// The conversation that uuid already names: `--resume <uuid>`.
    Resume(&'a str),
}

impl ClaudeSession<'_> {
    fn uuid(&self) -> &str {
        match self {
            Self::New(uuid) | Self::Resume(uuid) => uuid,
        }
    }

    fn is_resume(&self) -> bool {
        matches!(self, Self::Resume(_))
    }
}

/// Build the launch spec for `config`.
///
/// Returns `None` when the terminal should get a plain interactive shell:
/// `AgentType::Shell` always, and `AgentType::Custom` when `custom_args` is
/// empty or unparseable.
///
/// `session` carries the Claude Code session uuid and says whether the pane is
/// starting that conversation or rejoining it (see `pty::runtime`, which mints
/// the uuid for a fresh spawn and passes the renderer's for a resume);
/// `events_path` is the JSONL file the hooks append to and `agents::events`
/// tails; `rocplan` is the board's MCP server, when this pane has a project to
/// point it at and the binary could be found (`mcp_binary_path`).
///
/// Both of the last two are passed IN rather than resolved here so this stays a
/// pure function of its arguments: `mcp_binary_path` touches the filesystem and
/// `std::env::current_exe`, neither of which belongs in the mapping a test
/// wants to assert on.
pub fn launch_spec(
    config: &AgentConfig,
    session: ClaudeSession<'_>,
    events_path: &Path,
    rocplan: Option<RocPlanServer<'_>>,
) -> Option<LaunchSpec> {
    match config.agent_type {
        AgentType::ClaudeCode => Some(claude_code_spec(config, session, events_path, rocplan)),
        AgentType::Codex => Some(codex_spec(config)),
        AgentType::OpenCode => Some(opencode_spec(config)),
        AgentType::Shell => None,
        AgentType::Custom => custom_spec(config),
    }
}

// ---------------------------------------------------------------------------
// Per-agent builders
// ---------------------------------------------------------------------------

fn claude_code_spec(
    config: &AgentConfig,
    session: ClaudeSession<'_>,
    events_path: &Path,
    rocplan: Option<RocPlanServer<'_>>,
) -> LaunchSpec {
    let flag = if session.is_resume() {
        "--resume"
    } else {
        "--session-id"
    };
    let mut args = vec![flag.to_string(), session.uuid().to_string()];
    if let Some(model) = trimmed(&config.model) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.extend(permission_args(&config.permissions));
    args.push("--settings".to_string());
    args.push(hooks_settings_json(events_path));
    // Before the prompt, and NOT inside the `is_resume` guard below: the board
    // is a property of the pane, not of the conversation. A resumed session
    // that lost its tools would keep working right up until it tried to move
    // the card it was resumed to finish.
    if let Some(rocplan) = rocplan {
        args.push("--mcp-config".to_string());
        args.push(mcp_config_json(&rocplan));
    }
    // Last, so it is unambiguously the final positional argument: everything
    // above is a flag (or a flag's value) and Claude Code reads the trailing
    // positional as the initial prompt.
    //
    // Not on a resume. The trailing positional is a *message*, not a setting —
    // Claude Code sends it as the first turn — and the conversation being
    // resumed has already had this one. Re-sending it would make every restored
    // pane redo the task it was configured with, on top of whatever it had
    // already done: the same edits twice, or worse, edits that conflict with
    // the ones already on disk. The prompt is kept on the config for the pane's
    // next fresh start.
    if !session.is_resume() {
        push_task_prompt(&mut args, config);
    }
    LaunchSpec {
        program: "claude".to_string(),
        args,
    }
}

fn codex_spec(config: &AgentConfig) -> LaunchSpec {
    let mut args = Vec::new();
    if let Some(model) = trimmed(&config.model) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    push_task_prompt(&mut args, config);
    LaunchSpec {
        program: "codex".to_string(),
        args,
    }
}

fn opencode_spec(config: &AgentConfig) -> LaunchSpec {
    let mut args = Vec::new();
    push_task_prompt(&mut args, config);
    LaunchSpec {
        program: "opencode".to_string(),
        args,
    }
}

/// Append the task prompt as a positional argument, behind the `--`
/// end-of-options separator.
///
/// The prompt is free text from the Inspector, and free text starts with a
/// dash often enough to matter — "--- rewrite this ---", "-v mode: explain
/// every step", a pasted diff line. Without the separator every one of those
/// is read by the CLI's own argument parser, which rejects it as an unknown
/// option and the pane dies at launch instead of running the agent. All three
/// CLIs take `--` (commander for `claude`, clap for `codex`), and it costs one
/// argv entry when a prompt is set at all.
fn push_task_prompt(args: &mut Vec<String>, config: &AgentConfig) {
    if let Some(prompt) = trimmed(&config.task_prompt) {
        args.push("--".to_string());
        args.push(prompt.to_string());
    }
}

/// `custom_args` is already an argv: first element is the program, the rest are
/// its arguments, one entry each. Taken as-is.
///
/// It used to be joined with spaces and re-split under shell-word rules, which
/// silently destroyed anything the shell would have re-tokenized. A program
/// path with a space in it — `["/Applications/My Agent/bin/agent", "--flag"]`,
/// which is an ordinary macOS install location — came back as the program
/// `/Applications/My` with `Agent/bin/agent` as its first argument, and the
/// launch failed with a "not found" the `clear` had already scrolled away. A
/// lone quote in one element swallowed the elements after it. Rebuilding a
/// shell string from a structured argv only to parse it again cannot preserve
/// the argv, so the round trip is gone.
///
/// A missing or blank program degrades to a plain interactive shell rather
/// than exec'ing nothing.
fn custom_spec(config: &AgentConfig) -> Option<LaunchSpec> {
    let mut argv = config.custom_args.as_ref()?.iter();
    let program = argv.next()?.trim();
    if program.is_empty() {
        return None;
    }
    Some(LaunchSpec {
        program: program.to_string(),
        args: argv.cloned().collect(),
    })
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/// Permission toggles → Claude Code CLI flags. First match wins:
///
/// | condition (on `PermissionSettings`)                                   | flag                            |
/// |-----------------------------------------------------------------------|---------------------------------|
/// | `read_only_mode`                                                       | `--permission-mode plan`        |
/// | `auto_accept_edits` && `allow_file_edits` && `allow_package_installs` && `allow_git_commands` && !`ask_before_running_commands` | `--dangerously-skip-permissions` |
/// | `auto_accept_edits` && `allow_file_edits`                              | `--permission-mode acceptEdits` |
/// | otherwise                                                              | `--permission-mode default`     |
///
/// Every one of the six toggles participates, so none is silently dropped.
/// `read_only_mode` wins over the auto rows: a user who asks for read-only and
/// leaves an auto-accept toggle on gets the safe interpretation. Fidelity is
/// deliberately coarse — the CLI has three permission postures, the model has
/// six booleans.
fn permission_args(p: &PermissionSettings) -> Vec<String> {
    let mode = |m: &str| vec!["--permission-mode".to_string(), m.to_string()];

    if p.read_only_mode {
        return mode("plan");
    }
    let all_auto = p.auto_accept_edits
        && p.allow_file_edits
        && p.allow_package_installs
        && p.allow_git_commands
        && !p.ask_before_running_commands;
    if all_auto {
        return vec!["--dangerously-skip-permissions".to_string()];
    }
    if p.auto_accept_edits && p.allow_file_edits {
        return mode("acceptEdits");
    }
    mode("default")
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/// Compact `--settings` JSON that wires Claude Code's lifecycle hooks to a
/// single append-only JSONL file.
///
/// Each hook runs `cat >> '<events_path>'`, so the event payload Claude Code
/// writes to the hook's stdin (which carries `session_id` and
/// `hook_event_name`) is appended verbatim. `agents::events` tails that file
/// and turns the payloads into `agent://status` events, replacing the
/// renderer's 1500 ms silence heuristic for Claude panes.
///
/// `UserPromptSubmit` is registered alongside the three lifecycle hooks
/// because `Stop` fires at the end of *every* assistant turn, not on exit:
/// without a matching "the user asked for something" signal, the pane would
/// latch on the end-of-turn status after the first answer and never light up
/// again. For the same reason `Stop` maps to `idle` rather than `complete` —
/// see `events::status_for_hook`.
pub fn hooks_settings_json(events_path: &Path) -> String {
    let command = format!(
        "cat >> {}",
        posix_single_quote(&events_path.to_string_lossy())
    );
    let group = json!([{ "hooks": [{ "type": "command", "command": command }] }]);
    let settings = json!({
        "hooks": {
            "SessionStart": group,
            "UserPromptSubmit": group,
            "Stop": group,
            "Notification": group,
        }
    });
    // `to_string` (not `to_string_pretty`) — this travels as one argv entry.
    settings.to_string()
}

/// Wrap `s` in single quotes for POSIX `sh -c`, escaping embedded quotes the
/// only way single-quoted strings allow: close, escaped quote, reopen.
fn posix_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------------------
// RocPlan MCP server
// ---------------------------------------------------------------------------

/// The `--mcp-config` value that gives a Claude pane the board's tools:
///
/// ```json
/// { "mcpServers": { "rocplan": { "command": "<…>/rocspace-mcp", "args": ["<project>"] } } }
/// ```
///
/// Inline JSON rather than a file, for the same reason `--settings` is: it is
/// derived per pane, it would otherwise be a temp file somebody has to clean
/// up, and Claude Code accepts either. One argv entry, and the shell quoting on
/// the way to the PTY (`pty::runtime::posix_command_line`) is what keeps the
/// braces and quotes out of the shell's reach.
fn mcp_config_json(server: &RocPlanServer<'_>) -> String {
    let config = json!({
        "mcpServers": {
            MCP_SERVER_KEY: {
                "command": server.binary.to_string_lossy(),
                "args": [server.project_path],
            }
        }
    });
    // `to_string`, not `to_string_pretty` — this travels as one argv entry.
    config.to_string()
}

/// The project directory a pane can point the board's server at, if it has one
/// the server would accept.
///
/// Absolute only. `rocspace-mcp` resolves `.rocspace/` relative to ITS own
/// working directory, which is the agent's, so a relative path would put the
/// board somewhere neither the pane nor the window is looking — and the server
/// refuses to start on one, which Claude Code reports as a failed MCP server on
/// every launch. A pane whose cwd is not absolute gets no board rather than a
/// broken one.
pub fn rocplan_project(cwd: Option<&str>) -> Option<&str> {
    let cwd = cwd.map(str::trim).filter(|dir| !dir.is_empty())?;
    Path::new(cwd).is_absolute().then_some(cwd)
}

/// Where `rocspace-mcp` is, or `None` when it is not there.
///
/// Beside the running executable — the one rule that holds everywhere this app
/// runs. What makes it hold is that something now PUTS it there in each case,
/// which is the half that was missing:
///
/// - development (`cargo tauri dev`): the app runs from
///   `target/debug/rocspace`, and `beforeDevCommand` builds
///   `target/debug/rocspace-mcp` next to it (`pnpm mcp:build`). It did not, and
///   `cargo run` — which is what `cargo tauri dev` shells out to — builds only
///   the binary it is about to run. The server existed on a developer's machine
///   only when `cargo test` had happened to build it for the integration suite,
///   so a clean checkout launched every Claude pane without the board's tools
///   and nothing said so.
/// - bundled: `pnpm tauri:build` stages the release binary as
///   `src-tauri/binaries/rocspace-mcp-<target-triple>` and merges in
///   `tauri.bundle.conf.json`, whose `bundle.externalBin` puts it beside the
///   app — `RocSpace.app/Contents/MacOS/rocspace-mcp` on macOS, next to the
///   `.exe` on Windows, `/usr/bin` on Linux. Nothing shipped it at all before,
///   so no release could ever have had a working board.
///
/// The existence check is the point of returning an `Option`. A config naming a
/// binary that is not there is worse than no config at all: Claude Code retries
/// it on every launch and reports a failed MCP server to the user, who has no
/// way to act on it. No binary, no `--mcp-config`, no tools — and the pane
/// still starts.
pub fn mcp_binary_path() -> Option<PathBuf> {
    mcp_binary_beside(std::env::current_exe().ok()?.parent()?)
}

/// `mcp_binary_path`'s rule with the directory passed in, so a test can lay out
/// both of the layouts above and check the resolution rather than trusting it.
fn mcp_binary_beside(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join(mcp_binary_name());
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "windows")]
fn mcp_binary_name() -> &'static str {
    "rocspace-mcp.exe"
}

#[cfg(not(target_os = "windows"))]
fn mcp_binary_name() -> &'static str {
    "rocspace-mcp"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `Some(trimmed)` for a present, non-blank string; `None` otherwise. Blank
/// prompts/models are treated as unset so an empty Inspector field never
/// becomes an empty argv entry.
fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const UUID: &str = "11111111-2222-3333-4444-555555555555";

    fn events_path() -> PathBuf {
        PathBuf::from("/Users/roc/.rocspace/agent-events.jsonl")
    }

    fn config(agent_type: AgentType) -> AgentConfig {
        AgentConfig {
            agent_type,
            task_prompt: None,
            model: None,
            permissions: PermissionSettings::default(),
            custom_args: None,
        }
    }

    fn spec(config: &AgentConfig) -> Option<LaunchSpec> {
        launch_spec(config, ClaudeSession::New(UUID), &events_path(), None)
    }

    fn resumed(config: &AgentConfig) -> LaunchSpec {
        launch_spec(config, ClaudeSession::Resume(UUID), &events_path(), None).expect("has a spec")
    }

    const MCP_BINARY: &str = "/Applications/RocSpace.app/Contents/MacOS/rocspace-mcp";
    const PROJECT: &str = "/Users/roc/proj";

    fn rocplan(project_path: &str) -> RocPlanServer<'_> {
        RocPlanServer {
            binary: Path::new(MCP_BINARY),
            project_path,
        }
    }

    /// A spec built with the board's MCP server attached.
    fn spec_with_board(config: &AgentConfig, session: ClaudeSession<'_>) -> LaunchSpec {
        launch_spec(config, session, &events_path(), Some(rocplan(PROJECT))).expect("has a spec")
    }

    /// The `--mcp-config` value, parsed.
    fn mcp_config(args: &[String]) -> serde_json::Value {
        let raw = flag_value(args, "--mcp-config").expect("--mcp-config present");
        serde_json::from_str(raw).expect("valid JSON")
    }

    /// Value that follows `flag` in the argv.
    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    }

    fn has(args: &[String], value: &str) -> bool {
        args.iter().any(|a| a == value)
    }

    // -- Claude Code ------------------------------------------------------

    #[test]
    fn claude_code_launches_claude_with_the_session_id() {
        let spec = spec(&config(AgentType::ClaudeCode)).expect("claude has a spec");
        assert_eq!(spec.program, "claude");
        assert_eq!(flag_value(&spec.args, "--session-id"), Some(UUID));
    }

    // -- Resuming a conversation ------------------------------------------
    //
    // `--session-id` names a session to create and `--resume` names one to
    // continue. Passing both is an error, so the flag is REPLACED, not added.

    #[test]
    fn resuming_replaces_the_session_id_flag_with_resume() {
        let spec = resumed(&config(AgentType::ClaudeCode));

        assert_eq!(flag_value(&spec.args, "--resume"), Some(UUID));
        assert!(
            !has(&spec.args, "--session-id"),
            "--session-id and --resume cannot both be passed"
        );
    }

    #[test]
    fn resuming_keeps_the_model_permissions_and_hooks() {
        // Everything except the session flag describes the pane, not the
        // conversation, and a resumed pane is the same pane.
        let mut c = config(AgentType::ClaudeCode);
        c.model = Some("claude-opus-4-5".to_string());
        c.permissions.read_only_mode = true;

        let spec = resumed(&c);

        assert_eq!(flag_value(&spec.args, "--model"), Some("claude-opus-4-5"));
        assert_eq!(flag_value(&spec.args, "--permission-mode"), Some("plan"));
        assert!(flag_value(&spec.args, "--settings").is_some());
    }

    #[test]
    fn resuming_does_not_re_send_the_task_prompt() {
        // The trailing positional is a message, and the conversation being
        // resumed has already had this one. Sending it again makes every
        // restored pane redo the task it was configured with.
        let mut c = config(AgentType::ClaudeCode);
        c.task_prompt = Some("ship the thing".to_string());

        let resumed_spec = resumed(&c);

        assert!(!has(&resumed_spec.args, "ship the thing"));
        assert!(!has(&resumed_spec.args, "--"), "no prompt, no separator");
        // …and a fresh start with the same config still sends it.
        assert_eq!(
            spec(&c).unwrap().args.last().map(String::as_str),
            Some("ship the thing")
        );
    }

    #[test]
    fn resuming_is_claude_only() {
        // No other CLI is handed the uuid at all, so there is nothing for the
        // resume flag to replace.
        for agent in [AgentType::Codex, AgentType::OpenCode] {
            let spec = resumed(&config(agent));
            assert!(!has(&spec.args, "--resume"), "{agent:?}");
            assert!(!has(&spec.args, UUID), "{agent:?}");
        }
    }

    #[test]
    fn claude_code_omits_the_model_flag_when_unset() {
        let spec = spec(&config(AgentType::ClaudeCode)).unwrap();
        assert!(!has(&spec.args, "--model"));
    }

    #[test]
    fn claude_code_passes_the_model_when_set() {
        let mut c = config(AgentType::ClaudeCode);
        c.model = Some("claude-opus-4-5".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(flag_value(&spec.args, "--model"), Some("claude-opus-4-5"));
    }

    #[test]
    fn claude_code_task_prompt_is_the_final_positional_arg() {
        let mut c = config(AgentType::ClaudeCode);
        c.task_prompt = Some("  ship the thing  ".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(spec.args.last().map(String::as_str), Some("ship the thing"));
    }

    #[test]
    fn claude_code_drops_a_blank_task_prompt() {
        let mut c = config(AgentType::ClaudeCode);
        c.task_prompt = Some("   ".to_string());
        let spec = spec(&c).unwrap();
        // Last arg is the settings JSON, not an empty positional.
        assert!(flag_value(&spec.args, "--settings").is_some());
        assert!(!has(&spec.args, ""));
        assert!(!has(&spec.args, "--"), "no prompt, no separator");
        assert!(spec.args.last().unwrap().starts_with('{'));
    }

    // -- Prompts that look like options -----------------------------------
    //
    // The prompt is free text and free text starts with a dash often enough to
    // matter. Without `--` the CLI's own parser eats it and the pane dies at
    // launch on an unknown option.

    #[test]
    fn claude_code_prompt_starting_with_a_dash_is_not_read_as_an_option() {
        let mut c = config(AgentType::ClaudeCode);
        c.task_prompt = Some("--- rewrite this ---".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(
            &spec.args[spec.args.len() - 2..],
            &["--".to_string(), "--- rewrite this ---".to_string()]
        );
    }

    #[test]
    fn codex_prompt_starting_with_a_dash_is_not_read_as_an_option() {
        let mut c = config(AgentType::Codex);
        c.model = Some("gpt-5".to_string());
        c.task_prompt = Some("-v explain every step".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(
            spec.args,
            vec!["--model", "gpt-5", "--", "-v explain every step"]
        );
    }

    #[test]
    fn opencode_prompt_starting_with_a_dash_is_not_read_as_an_option() {
        let mut c = config(AgentType::OpenCode);
        c.task_prompt = Some("-p refactor".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(spec.args, vec!["--", "-p refactor"]);
    }

    #[test]
    fn the_separator_comes_before_the_prompt_and_nothing_follows_it() {
        // A second `--` or a trailing flag would put the prompt back in the
        // parser's reach.
        for agent in [AgentType::ClaudeCode, AgentType::Codex, AgentType::OpenCode] {
            let mut c = config(agent);
            c.task_prompt = Some("-x".to_string());
            let spec = spec(&c).unwrap();
            let sep = spec
                .args
                .iter()
                .position(|a| a == "--")
                .unwrap_or_else(|| panic!("{agent:?} passes the separator"));
            assert_eq!(sep, spec.args.len() - 2, "{agent:?}");
            assert_eq!(
                spec.args.last().map(String::as_str),
                Some("-x"),
                "{agent:?}"
            );
        }
    }

    // -- Permission mapping ----------------------------------------------

    #[test]
    fn conservative_defaults_map_to_default_permission_mode() {
        let spec = spec(&config(AgentType::ClaudeCode)).unwrap();
        assert_eq!(flag_value(&spec.args, "--permission-mode"), Some("default"));
        assert!(!has(&spec.args, "--dangerously-skip-permissions"));
    }

    #[test]
    fn every_auto_toggle_on_maps_to_skip_permissions() {
        let mut c = config(AgentType::ClaudeCode);
        c.permissions = PermissionSettings {
            auto_accept_edits: true,
            ask_before_running_commands: false,
            read_only_mode: false,
            allow_file_edits: true,
            allow_package_installs: true,
            allow_git_commands: true,
        };
        let spec = spec(&c).unwrap();
        assert!(has(&spec.args, "--dangerously-skip-permissions"));
        assert!(!has(&spec.args, "--permission-mode"));
    }

    #[test]
    fn edits_only_auto_maps_to_accept_edits() {
        let mut c = config(AgentType::ClaudeCode);
        c.permissions.auto_accept_edits = true;
        c.permissions.allow_file_edits = true;
        let spec = spec(&c).unwrap();
        assert_eq!(
            flag_value(&spec.args, "--permission-mode"),
            Some("acceptEdits")
        );
    }

    #[test]
    fn read_only_mode_wins_over_auto_accept() {
        let mut c = config(AgentType::ClaudeCode);
        c.permissions = PermissionSettings {
            auto_accept_edits: true,
            ask_before_running_commands: false,
            read_only_mode: true,
            allow_file_edits: true,
            allow_package_installs: true,
            allow_git_commands: true,
        };
        let spec = spec(&c).unwrap();
        assert_eq!(flag_value(&spec.args, "--permission-mode"), Some("plan"));
        assert!(!has(&spec.args, "--dangerously-skip-permissions"));
    }

    #[test]
    fn auto_accept_without_file_edits_stays_default() {
        let mut c = config(AgentType::ClaudeCode);
        c.permissions.auto_accept_edits = true;
        c.permissions.allow_file_edits = false;
        let spec = spec(&c).unwrap();
        assert_eq!(flag_value(&spec.args, "--permission-mode"), Some("default"));
    }

    // -- Hooks settings ---------------------------------------------------

    #[test]
    fn settings_json_registers_every_status_hook() {
        let spec = spec(&config(AgentType::ClaudeCode)).unwrap();
        let raw = flag_value(&spec.args, "--settings").expect("--settings present");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid JSON");
        let hooks = parsed.get("hooks").expect("hooks key");
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] {
            let entry = hooks.get(event).unwrap_or_else(|| panic!("{event} hook"));
            let command = entry[0]["hooks"][0]["command"].as_str().expect("command");
            assert_eq!(entry[0]["hooks"][0]["type"], "command");
            assert!(
                command.contains("agent-events.jsonl"),
                "{event} appends to the events file, got {command}"
            );
            assert!(command.starts_with("cat >> "), "got {command}");
        }
    }

    #[test]
    fn settings_json_is_compact_single_line() {
        let spec = spec(&config(AgentType::ClaudeCode)).unwrap();
        let raw = flag_value(&spec.args, "--settings").unwrap();
        assert!(!raw.contains('\n'), "settings JSON must be one argv entry");
    }

    #[test]
    fn hook_command_shell_escapes_the_events_path() {
        let json = hooks_settings_json(Path::new("/tmp/ro'c/events.jsonl"));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let command = parsed["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(command, r"cat >> '/tmp/ro'\''c/events.jsonl'");
    }

    // -- The RocPlan MCP server -------------------------------------------

    #[test]
    fn a_claude_pane_with_a_project_gets_the_board_as_an_mcp_server() {
        let spec = spec_with_board(&config(AgentType::ClaudeCode), ClaudeSession::New(UUID));

        let config = mcp_config(&spec.args);
        assert_eq!(config["mcpServers"]["rocplan"]["command"], MCP_BINARY);
        assert_eq!(config["mcpServers"]["rocplan"]["args"], json!([PROJECT]));
    }

    #[test]
    fn a_claude_pane_without_a_project_gets_no_mcp_config() {
        // A workspace with no project directory has no board, and a server
        // pointed at nothing would be a failed MCP server reported on every
        // launch.
        let spec = spec(&config(AgentType::ClaudeCode)).unwrap();
        assert!(!has(&spec.args, "--mcp-config"));
    }

    #[test]
    fn the_mcp_config_is_one_compact_argv_entry() {
        let spec = spec_with_board(&config(AgentType::ClaudeCode), ClaudeSession::New(UUID));
        let raw = flag_value(&spec.args, "--mcp-config").unwrap();

        assert!(!raw.contains('\n'), "must be one argv entry");
        assert!(raw.starts_with('{'), "got {raw}");
    }

    #[test]
    fn resuming_keeps_the_board() {
        // The board belongs to the pane, not to the conversation. A resumed
        // session that lost its tools keeps working right up until it tries to
        // move the card it was resumed to finish.
        let spec = spec_with_board(&config(AgentType::ClaudeCode), ClaudeSession::Resume(UUID));

        assert_eq!(
            mcp_config(&spec.args)["mcpServers"]["rocplan"]["args"],
            json!([PROJECT])
        );
        assert_eq!(flag_value(&spec.args, "--resume"), Some(UUID));
    }

    #[test]
    fn the_mcp_config_comes_before_the_prompt_separator() {
        // Everything after `--` is the prompt. A flag that landed there would
        // be sent to the model as text instead of configuring the CLI.
        let mut c = config(AgentType::ClaudeCode);
        c.task_prompt = Some("ship it".to_string());
        let spec = spec_with_board(&c, ClaudeSession::New(UUID));

        let flag = spec.args.iter().position(|a| a == "--mcp-config").unwrap();
        let separator = spec.args.iter().position(|a| a == "--").unwrap();
        assert!(flag < separator, "{:?}", spec.args);
        assert_eq!(spec.args.last().map(String::as_str), Some("ship it"));
    }

    #[test]
    fn a_project_path_with_shell_characters_survives_as_written() {
        // The path is free text from a directory picker and it travels through
        // a JSON document inside an argv entry inside a shell command line.
        for hostile in [
            "/Users/roc/My Projects/it's here",
            "/Users/roc/$(rm -rf ~)",
            "/Users/roc/\"quoted\"",
        ] {
            let spec = launch_spec(
                &config(AgentType::ClaudeCode),
                ClaudeSession::New(UUID),
                &events_path(),
                Some(rocplan(hostile)),
            )
            .unwrap();

            assert_eq!(
                mcp_config(&spec.args)["mcpServers"]["rocplan"]["args"][0],
                hostile
            );
        }
    }

    #[test]
    fn no_other_agent_type_is_given_an_mcp_config() {
        // Only Claude Code takes `--mcp-config`; handing it to the others is an
        // unknown option and a pane that dies at launch.
        for agent in [
            AgentType::Codex,
            AgentType::OpenCode,
            AgentType::Shell,
            AgentType::Custom,
        ] {
            let mut c = config(agent);
            c.custom_args = Some(vec!["my-agent".to_string()]);
            let spec = launch_spec(
                &c,
                ClaudeSession::New(UUID),
                &events_path(),
                Some(rocplan(PROJECT)),
            );
            if let Some(spec) = spec {
                assert!(!has(&spec.args, "--mcp-config"), "{agent:?}");
                assert!(!has(&spec.args, PROJECT), "{agent:?}");
            }
        }
    }

    #[test]
    fn the_server_is_filed_under_the_name_the_tools_are_prefixed_with() {
        // `rocplan` is the key, so the tools reach the model as
        // `mcp__rocplan__rocplan_update_task_status` — which is what the prompt
        // a dispatched card carries refers to.
        let spec = spec_with_board(&config(AgentType::ClaudeCode), ClaudeSession::New(UUID));
        let servers = &mcp_config(&spec.args)["mcpServers"];

        let names: Vec<&String> = servers.as_object().unwrap().keys().collect();
        assert_eq!(names, vec!["rocplan"]);
    }

    #[test]
    fn only_an_absolute_cwd_is_a_project_the_board_server_can_serve() {
        // `rocspace-mcp` resolves `.rocspace/` against ITS working directory,
        // which is the agent's. A relative path there means the agent writes a
        // board into whatever directory it is sitting in — committed with the
        // work, and nowhere the window is looking. The server refuses to start
        // on one, so a pane like this gets no board rather than an MCP server
        // Claude Code reports as broken on every launch.
        for refused in [None, Some(""), Some("   "), Some("proj"), Some("./proj")] {
            assert_eq!(rocplan_project(refused), None, "{refused:?} was accepted");
        }
        assert_eq!(rocplan_project(Some(PROJECT)), Some(PROJECT));
        assert_eq!(
            rocplan_project(Some("  /Users/roc/proj  ")),
            Some("/Users/roc/proj")
        );
    }

    #[test]
    fn the_mcp_binary_is_only_reported_when_it_is_really_there() {
        // The whole value of the `Option`: a config naming a binary that does
        // not exist is a failed MCP server on every launch, and the user has no
        // way to act on it. Under `cargo test` the running executable is a test
        // harness in `target/debug/deps`, so this is normally `None` — what is
        // asserted is the invariant, not which branch this machine takes.
        if let Some(path) = mcp_binary_path() {
            assert!(path.is_file(), "{path:?}");
            assert!(path.ends_with(mcp_binary_name()), "{path:?}");
        }
    }

    #[test]
    fn the_server_is_found_in_both_of_the_layouts_it_ships_in() {
        // The two places the binary is put, simulated. `cargo test` cannot run
        // from either of them — the harness lives in `target/debug/deps` — so
        // the resolution rule is exercised against the shapes rather than
        // against whatever this machine happens to have.
        let tmp = tempfile::tempdir().expect("tempdir");
        for layout in [
            // `cargo tauri dev`, after `beforeDevCommand` ran `pnpm mcp:build`.
            PathBuf::from("target").join("debug"),
            // A bundle, after `externalBin` copied the staged sidecar in.
            PathBuf::from("RocSpace.app").join("Contents").join("MacOS"),
        ] {
            let dir = tmp.path().join(layout);
            std::fs::create_dir_all(&dir).expect("dir");
            // The app is there; the server is not yet.
            std::fs::write(dir.join("rocspace"), b"the app").expect("write");
            assert_eq!(mcp_binary_beside(&dir), None, "{dir:?}");

            std::fs::write(dir.join(mcp_binary_name()), b"the server").expect("write");

            assert_eq!(mcp_binary_beside(&dir), Some(dir.join(mcp_binary_name())));
        }
    }

    #[test]
    fn a_directory_wearing_the_servers_name_is_not_the_server() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join(mcp_binary_name())).expect("dir");

        assert_eq!(mcp_binary_beside(tmp.path()), None);
    }

    // -- Codex / OpenCode -------------------------------------------------

    #[test]
    fn codex_takes_model_and_prompt() {
        let mut c = config(AgentType::Codex);
        c.model = Some("gpt-5".to_string());
        c.task_prompt = Some("fix the build".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "codex");
        assert_eq!(spec.args, vec!["--model", "gpt-5", "--", "fix the build"]);
    }

    #[test]
    fn codex_without_config_has_no_args() {
        let spec = spec(&config(AgentType::Codex)).unwrap();
        assert_eq!(spec.program, "codex");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn codex_never_receives_claude_only_flags() {
        let mut c = config(AgentType::Codex);
        c.task_prompt = Some("go".to_string());
        let spec = spec(&c).unwrap();
        assert!(!has(&spec.args, "--session-id"));
        assert!(!has(&spec.args, "--settings"));
        assert!(!has(&spec.args, "--permission-mode"));
    }

    #[test]
    fn opencode_takes_only_the_prompt() {
        let mut c = config(AgentType::OpenCode);
        c.model = Some("ignored".to_string());
        c.task_prompt = Some("refactor".to_string());
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "opencode");
        assert_eq!(spec.args, vec!["--", "refactor"]);
    }

    #[test]
    fn opencode_without_a_prompt_has_no_args() {
        let spec = spec(&config(AgentType::OpenCode)).unwrap();
        assert!(spec.args.is_empty());
    }

    // -- Resolving the program --------------------------------------------
    //
    // Every builder above names its CLI the way a person types it, and the PTY
    // runs the result through a NON-interactive `$SHELL -c`. A bare name that
    // reached that shell in a packaged app — whose PATH is
    // `/usr/bin:/bin:/usr/sbin:/sbin` — was `command not found`, every time.

    #[test]
    fn every_agent_cli_looked_up_by_name_is_resolved_to_an_absolute_path() {
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec!["my-agent".to_string(), "--flag".to_string()]);
        let custom = spec(&c).expect("custom has a spec");

        for spec in [
            spec(&config(AgentType::ClaudeCode)).unwrap(),
            spec(&config(AgentType::Codex)).unwrap(),
            spec(&config(AgentType::OpenCode)).unwrap(),
            custom,
        ] {
            let name = spec.program.clone();
            let args = spec.args.clone();
            let resolved = spec
                .resolved(|name| Ok(PathBuf::from(format!("/opt/homebrew/bin/{name}"))))
                .expect("resolvable");

            assert_eq!(resolved.program, format!("/opt/homebrew/bin/{name}"));
            assert!(Path::new(&resolved.program).is_absolute());
            assert_eq!(resolved.args, args, "the argv is untouched");
        }
    }

    #[test]
    fn a_program_that_is_already_a_path_is_left_exactly_as_written() {
        // The user pointed `AgentType::Custom` at a file. That is not a name to
        // look up, and re-resolving it would run something else.
        for written in [
            "/Applications/My Agent/bin/agent",
            "./agent",
            "bin/agent",
            "../agent",
        ] {
            let mut c = config(AgentType::Custom);
            c.custom_args = Some(vec![written.to_string()]);
            let resolved = spec(&c)
                .unwrap()
                .resolved(|_| panic!("{written} was looked up"))
                .expect("resolvable");

            assert_eq!(resolved.program, written);
        }
    }

    #[test]
    fn a_cli_that_cannot_be_found_fails_the_launch_with_the_reason() {
        let err = spec(&config(AgentType::ClaudeCode))
            .unwrap()
            .resolved(|name| Err(format!("no {name} anywhere")))
            .unwrap_err();

        assert_eq!(err, "no claude anywhere");
    }

    // -- Shell / Custom ---------------------------------------------------

    #[test]
    fn shell_has_no_launch_spec() {
        assert_eq!(spec(&config(AgentType::Shell)), None);
    }

    #[test]
    fn custom_reads_the_argv_as_program_then_arguments() {
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec![
            "my-agent".to_string(),
            "--flag".to_string(),
            "value".to_string(),
        ]);
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "my-agent");
        assert_eq!(spec.args, vec!["--flag", "value"]);
    }

    #[test]
    fn custom_keeps_a_program_path_with_spaces_intact() {
        // Joining the argv and re-splitting it made this `/Applications/My`
        // with `Agent/bin/agent` as an argument, and the launch died on a
        // "not found" the pane's `clear` had already wiped.
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec![
            "/Applications/My Agent/bin/agent".to_string(),
            "--flag".to_string(),
        ]);
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "/Applications/My Agent/bin/agent");
        assert_eq!(spec.args, vec!["--flag"]);
    }

    #[test]
    fn custom_keeps_an_argument_with_spaces_as_one_entry() {
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec![
            "my-agent".to_string(),
            "--message".to_string(),
            "two words".to_string(),
        ]);
        let spec = spec(&c).unwrap();
        assert_eq!(spec.args, vec!["--message", "two words"]);
    }

    #[test]
    fn custom_does_not_reinterpret_quotes_inside_an_argument() {
        // An argv entry is a literal. Re-splitting used to give a lone quote
        // the power to swallow every entry after it — or, unbalanced, to drop
        // the whole launch back to a plain shell.
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec![
            "my-agent".to_string(),
            "it's fine".to_string(),
            "--next".to_string(),
        ]);
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "my-agent");
        assert_eq!(spec.args, vec!["it's fine", "--next"]);
    }

    #[test]
    fn custom_without_args_falls_back_to_a_plain_shell() {
        assert_eq!(spec(&config(AgentType::Custom)), None);
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec![]);
        assert_eq!(spec(&c), None);
        c.custom_args = Some(vec!["   ".to_string()]);
        assert_eq!(spec(&c), None);
    }

    #[test]
    fn custom_with_a_program_but_no_arguments_still_launches() {
        let mut c = config(AgentType::Custom);
        c.custom_args = Some(vec!["my-agent".to_string()]);
        let spec = spec(&c).unwrap();
        assert_eq!(spec.program, "my-agent");
        assert!(spec.args.is_empty());
    }
}
