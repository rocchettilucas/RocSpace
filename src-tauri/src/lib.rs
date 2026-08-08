pub mod agents;
pub mod cli_binary;
pub mod fs_browse;
pub mod git;
pub mod git_info;
pub mod mcp;
#[cfg(target_os = "macos")]
pub mod menu;
pub mod models;
pub mod pty;
pub mod roc_brain;
pub mod rocmind;
pub mod rocplan;
pub mod roctalk;
pub mod sessions;
pub mod shell_env;
pub mod web_preview;

use fs_browse::{fs_read_dir, fs_read_file, fs_write_file};
use git::{
    git_branches, git_checkout, git_commit, git_diff, git_stage, git_status, git_unstage,
    git_worktree_add,
};
use git_info::GitWatcher;
use models::{AgentConfig, SpawnResult};
use pty::runtime::PtyRuntime;
use roc_brain::{roc_list_voices, roc_speak, roc_stop_speaking, roc_think};
use rocmind::{MindMemory, MindScope, MindWatcher};
use rocplan::{plan_read, plan_unwatch, plan_watch, plan_write, RocPlanWatcher};
use roctalk::{
    ptt_current, ptt_register, ptt_unregister, roctalk_download_model, roctalk_get_model_status,
    roctalk_list_input_devices, roctalk_set_enabled, roctalk_start_recording,
    roctalk_stop_recording_and_transcribe, RocTalkState,
};
use sessions::{session_delete, session_list, session_load, session_save};
use tauri::{AppHandle, Manager, State, Wry};
use tauri_specta::{collect_commands, Builder};
use web_preview::{
    web_preview_close, web_preview_set_bounds, web_preview_set_visible, web_preview_show,
};

/// The app's only window — the label Tauri gives a window that does not name
/// itself, which is what `tauri.conf.json` declares.
///
/// Named here rather than at either use site because two unrelated features
/// have to agree on it: `web_preview` parents its webview to this window, and
/// the single-instance handler below raises it when a second launch is
/// attempted. A mismatch in the second one fails silently — no window, no
/// error, just an `open -n` that appears to do nothing.
pub const MAIN_WINDOW: &str = "main";

/// Sanity command — returns "pong". Used by the renderer to verify the IPC + bindings pipeline.
#[tauri::command]
#[specta::specta]
fn ping() -> String {
    "pong".to_string()
}

/// Spawn (or restart) a real PTY for the given terminal.
///
/// Takes the whole `AgentConfig`, not just the type: model, permissions, task
/// prompt and custom args are translated into the CLI's argv by
/// `agents::command::launch_spec`. Emits `terminal://output` and
/// `terminal://status` events; returns the child pid plus the Claude Code
/// session uuid (when the pane runs Claude Code) for the renderer to record.
///
/// `resume_claude_session` (camelCase `resumeClaudeSession` over IPC) asks for
/// an existing Claude conversation to be rejoined rather than a new one
/// started — the pane keeps that uuid and the CLI is launched with `--resume`.
#[tauri::command]
#[specta::specta]
// Eight parameters because a Tauri command's arguments ARE its wire format:
// bundling them into a struct to satisfy the lint would change the IPC shape
// that `bindings.ts` mirrors, for no gain the caller can see.
#[allow(clippy::too_many_arguments)]
fn terminal_spawn(
    state: State<'_, PtyRuntime>,
    app: AppHandle,
    terminal_id: String,
    config: AgentConfig,
    cwd: Option<String>,
    resume_claude_session: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    // Both or neither: half a size is not a size, and guessing the other half
    // is how you get the mismatch this parameter exists to prevent.
    let size = match (cols, rows) {
        (Some(c), Some(r)) if c > 0 && r > 0 => Some((c, r)),
        _ => None,
    };
    state.spawn(app, terminal_id, config, cwd, resume_claude_session, size)
}

/// Write input bytes (typed by the user in xterm) to the PTY's stdin.
#[tauri::command]
#[specta::specta]
fn terminal_write(
    state: State<'_, PtyRuntime>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    state.write(&terminal_id, data.as_bytes())
}

/// Resize the PTY (called whenever the xterm container's size changes).
#[tauri::command]
#[specta::specta]
fn terminal_resize(
    state: State<'_, PtyRuntime>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&terminal_id, cols, rows)
}

/// Is there still a Claude Code conversation behind this uuid?
///
/// The question the resume OFFER has to ask. A cold pane parks its uuid and
/// shows "pick it up where it left off" — and a session the user never sent a
/// turn in leaves no conversation at all, so that offer was frequently for
/// something that no longer exists and would kill the pane if accepted (see
/// `agents::transcript`). `terminal_spawn` recovers from that on its own; this
/// is how the offer stops being made in the first place.
///
/// `async`, and doing its filesystem work on the blocking pool, for the reason
/// RocMind's commands are: a synchronous command runs on the MAIN thread, and
/// this one lists a directory per project on a home directory that may be on a
/// network volume. One per cold pane, at boot, is exactly when a frozen window
/// would be most visible.
///
/// `false` only when the absence is certain; anything unreadable leaves the
/// offer standing.
#[tauri::command]
#[specta::specta]
async fn claude_conversation_exists(claude_session_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        !agents::transcript::conversation_lost(&claude_session_id)
    })
    .await
    .unwrap_or(true)
}

/// Kill the PTY's child process and clean up.
#[tauri::command]
#[specta::specta]
fn terminal_kill(state: State<'_, PtyRuntime>, terminal_id: String) -> Result<(), String> {
    state.kill(&terminal_id)
}

// The three git commands are `async fn` for the same reason `web_preview`'s
// are: a synchronous Tauri command runs on the MAIN thread, and every one of
// these ends in a `canonicalize` plus a file read. On a network volume that has
// stopped answering — a mounted share, a sleeping external disk, an sshfs whose
// host went away — those calls block for as long as the kernel makes them, and
// blocking the main thread is a frozen window: not a missing branch chip, a
// dead application. `async` moves them onto the async runtime, where a stalled
// read costs one task and the renderer keeps painting.
//
// `git_watch` and `git_unwatch` borrow state, and Tauri requires an async
// command with a borrowed argument to return a `Result`. Neither can actually
// fail; the `Ok` is the price of the lifetime.

/// Which branch a directory is on — a one-shot answer for a caller that does
/// not want a watch. `None` means the path is not inside a repository.
///
/// The pane header does NOT use this: a watcher's opening value has to be the
/// same read that seeded its baseline, so `git_watch` returns it. Kept for the
/// one-shot question, which the sidebar and the launch wizard will want.
#[tauri::command]
#[specta::specta]
async fn git_branch(path: String) -> Option<String> {
    git_info::branch_at(std::path::Path::new(&path))
}

/// Follow the HEAD of whatever repository `path` is in, emitting
/// `git://branch` when it moves.
///
/// Returns the repository root the path resolved to, and the branch the watch
/// was seeded with. The root is the watch's identity: it labels the events, and
/// it is what `git_unwatch` takes. Two panes in one project — or one pane in a
/// subdirectory of another's — resolve to the same root and share a single
/// reference-counted watch.
///
/// The branch comes back from here rather than from `git_branch` so that the
/// caller's opening value and the watcher's baseline are one read. See
/// `GitWatchHandle`.
#[tauri::command]
#[specta::specta]
async fn git_watch(
    state: State<'_, GitWatcher>,
    path: String,
) -> Result<git_info::GitWatchHandle, String> {
    Ok(state.watch(std::path::Path::new(&path)).into())
}

/// Drop one pane's interest in a repository. Takes the root `git_watch`
/// returned, not the path that was passed to it.
#[tauri::command]
#[specta::specta]
async fn git_unwatch(state: State<'_, GitWatcher>, root: String) -> Result<(), String> {
    state.unwatch(std::path::Path::new(&root));
    Ok(())
}

// RocMind. Every one of these is `async` and does its filesystem work on the
// blocking pool, for the reason `fs_browse` spells out: a synchronous Tauri
// command runs on the MAIN thread, and `mind_scopes` walks a directory per
// project while `mind_list` reads sixty files. On a network home directory —
// which is not exotic; a managed Mac has one — that is a frozen window.
//
// `~/.claude/projects` missing is not an error anywhere below. It is the state
// of a machine whose agents have not written a memory yet, and RocMind's empty
// state says so far better than a red banner would.

/// Every project scope that holds at least one memory.
#[tauri::command]
#[specta::specta]
async fn mind_scopes() -> Vec<MindScope> {
    let Some(root) = rocmind::projects_root() else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || rocmind::scopes_in(&root))
        .await
        .unwrap_or_default()
}

/// One scope's memories, headers only — no bodies. `mind_read` fetches the one
/// the user opens.
#[tauri::command]
#[specta::specta]
async fn mind_list(scope: String) -> Vec<MindMemory> {
    let Some(root) = rocmind::projects_root() else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || rocmind::list_in(&root, &scope))
        .await
        .unwrap_or_default()
}

/// One memory's contents. `path` must canonicalize inside
/// `~/.claude/projects` — see `rocmind::read_in`.
#[tauri::command]
#[specta::specta]
async fn mind_read(path: String) -> Result<String, String> {
    let root = rocmind::projects_root().ok_or("no home directory")?;
    tauri::async_runtime::spawn_blocking(move || rocmind::read_in(&root, &path))
        .await
        .map_err(|e| format!("memory read failed: {e}"))?
}

/// Follow a scope's memory directory, emitting `rocmind://changed` when a
/// memory is written, edited or deleted. Reference-counted — pass the same slug
/// to `mind_unwatch`, which is also the string the events are labelled with.
#[tauri::command]
#[specta::specta]
async fn mind_watch(state: State<'_, MindWatcher>, scope: String) -> Result<(), String> {
    if let Some(root) = rocmind::projects_root() {
        state.watch(&root, &scope);
    }
    Ok(())
}

/// Drop one caller's interest in a scope.
#[tauri::command]
#[specta::specta]
async fn mind_unwatch(state: State<'_, MindWatcher>, scope: String) -> Result<(), String> {
    state.unwatch(&scope);
    Ok(())
}

fn make_specta_builder() -> Builder<Wry> {
    Builder::<Wry>::new().commands(collect_commands![
        ping,
        terminal_spawn,
        terminal_write,
        terminal_resize,
        terminal_kill,
        claude_conversation_exists,
        roctalk_start_recording,
        roctalk_stop_recording_and_transcribe,
        roctalk_set_enabled,
        roctalk_get_model_status,
        roctalk_download_model,
        roctalk_list_input_devices,
        ptt_register,
        ptt_unregister,
        ptt_current,
        fs_read_dir,
        fs_read_file,
        fs_write_file,
        session_save,
        session_list,
        session_load,
        session_delete,
        git_branch,
        git_watch,
        git_unwatch,
        // The panel's git (src/git), as opposed to the pane header's
        // (src/git_info): these shell out, run when a human clicks, and can
        // change the repository.
        git_status,
        git_diff,
        git_stage,
        git_unstage,
        git_commit,
        git_branches,
        git_checkout,
        git_worktree_add,
        plan_read,
        plan_write,
        plan_watch,
        plan_unwatch,
        // Roc's brain: one headless `claude -p` turn, so a spoken request can
        // be reasoned about before anything is dispatched — and the reply said
        // out loud through macOS `say`.
        roc_think,
        roc_speak,
        roc_stop_speaking,
        roc_list_voices,
        mind_scopes,
        mind_list,
        mind_read,
        mind_watch,
        mind_unwatch,
        web_preview_show,
        web_preview_set_bounds,
        web_preview_set_visible,
        web_preview_close,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = make_specta_builder();

    #[allow(unused_mut)]
    let mut tauri_builder = tauri::Builder::default();
    // FIRST, which the plugin requires — a second launch has to be answered
    // before anything else in the app starts reacting to it.
    //
    // Two RocSpaces are not two windows, they are two of everything this app
    // keeps on disk and one of every accelerator it registers: both tailers
    // ingest the other's hook events out of `~/.rocspace/agent-events.jsonl`
    // (so a pane's status is set by a session in the other instance) and the
    // truncation in `agents::events` runs on a file the other one is following;
    // `settings.dat` and `workspace.dat` are last-writer-wins, so whichever
    // instance is closed second silently discards the other's workspaces; and
    // the push-to-talk hotkey is a single global registration that only one of
    // them can hold. `open -n` is a supported way to ask for a second one, so
    // this is not theoretical.
    //
    // Raising the window that already exists is the whole handler: the second
    // process has nothing to hand over — no file to open, no URL — so `argv`
    // and `cwd` are ignored.
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_single_instance::init(
            |app, _argv, _cwd| {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    // All three, because the running instance can be in any of
                    // three states the user meant to get out of: minimised,
                    // hidden, or merely behind something.
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ));
    }
    // macOS binds ⌘W from the default menu's "Close Window", which would beat
    // the dock's own ⌘W (close the focused pane) and take every PTY in the
    // window with it. See `menu` for what the replacement keeps.
    #[cfg(target_os = "macos")]
    {
        tauri_builder = tauri_builder.menu(menu::build);
    }

    tauri_builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(PtyRuntime::new())
        .manage(RocTalkState::default())
        .manage(GitWatcher::default())
        .manage(RocPlanWatcher::default())
        .manage(MindWatcher::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            // Claude Code's hooks append to this file from their own processes;
            // create it up front so the first `cat >>` never races the dir,
            // then follow it for the lifetime of the app. The tailer resolves
            // session ids against `PtyRuntime`, which is already managed above.
            match agents::ensure_events_file() {
                Ok(path) => agents::events::spawn_tailer(app.handle().clone(), path),
                Err(e) => eprintln!("[agents] could not create the events file: {e}"),
            }
            // Follows whatever the pane headers ask it to; idle until then.
            git_info::spawn_watcher(app.handle().clone());
            // Same shape for the RocPlan board files: idle until a board is
            // open, then one `stat` a second per project so an agent's edit
            // through the MCP server reaches the board.
            rocplan::watch::spawn_watcher(app.handle().clone());
            // And the same again for the memory directories Claude Code
            // writes: idle until RocMind (or an open workspace) asks for a
            // scope, then one directory listing every couple of seconds so a
            // memory an agent just wrote appears without a reload.
            rocmind::spawn_watcher(app.handle().clone());
            if let Err(e) = roctalk::install_hotkey(app.handle().clone()) {
                eprintln!("[roctalk] hotkey install failed: {e}");
            }
            // Find `claude` now, on a thread of its own. `terminal_spawn` is a
            // synchronous command, so it runs on the MAIN thread — and in a
            // packaged app the answer costs an interactive shell start, which
            // would be a window that does not paint for the length of the
            // user's `~/.zshrc` on the click that opens their first pane.
            // Claude Code alone because it is the agent panes default to; the
            // other CLIs pay for their own first launch.
            cli_binary::warm(cli_binary::CLAUDE);
            // And, on another, the environment those CLIs will run IN. Same
            // reason, one layer out: launchd gives a Finder-launched app
            // `/usr/bin:/bin:/usr/sbin:/sbin`, every PTY child inherits it, and
            // an agent that cannot see `node` or `pnpm` cannot run the user's
            // project. See `shell_env` — including why this must never be
            // waited for on this thread.
            shell_env::warm();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building RocSpace")
        .run(|app_handle, event| {
            // Kill every PTY child on the way out — otherwise the shells (and
            // the agent CLIs exec'd over them) outlive the app as orphans.
            // `Exit` is handled too because a programmatic `app.exit()` skips
            // `ExitRequested`; `kill_all` drains the map, so running twice is
            // a no-op the second time.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(rt) = app_handle.try_state::<PtyRuntime>() {
                    rt.kill_all();
                }
            }
        });
}
