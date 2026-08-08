// Hand-maintained bindings for RocSpace.
// Commands section mirrors tauri-specta output. Types mirror src-tauri/src/models.rs
// with camelCase serde transforms applied. Update manually if Rust types change.

import { invoke as __TAURI_INVOKE } from "@tauri-apps/api/core";
import type { PaneNode } from "@/lib/paneTree";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const commands = {
  ping: () => __TAURI_INVOKE<string>("ping"),
  /** Spawn (or restart) a real PTY for the given terminal.
   *
   *  Takes the whole `AgentConfig`: Rust derives the CLI's argv from it
   *  (`agents::command::launch_spec`), so model / permissions / task prompt /
   *  custom args reach the spawned process. Returns the child pid and, for
   *  Claude Code panes, the freshly generated `--session-id` — record both on
   *  the session (prefer `spawnTerminal` in `@/lib/spawn`, which does).
   *
   *  `resumeClaudeSession` asks for an existing Claude conversation to be
   *  rejoined: the CLI gets `--resume <uuid>` INSTEAD of `--session-id <uuid>`
   *  (they are mutually exclusive), and the pane keeps that uuid, so it comes
   *  back in the `SpawnResult` unchanged. */
  /** `cols`/`rows` open the PTY at the size the pane is already showing. A TUI
   *  reads its width once at startup, so a PTY born at the default 80x24 inside
   *  a narrower pane makes the agent wrap its own interface — and the resize
   *  that would correct it is dropped when it fires before the PTY exists,
   *  which on a session restore is exactly what happens. */
  terminalSpawn: (
    terminalId: string,
    config: AgentConfig,
    cwd: string | null,
    resumeClaudeSession: string | null = null,
    cols: number | null = null,
    rows: number | null = null,
  ) =>
    __TAURI_INVOKE<SpawnResult>("terminal_spawn", {
      terminalId,
      config,
      cwd,
      resumeClaudeSession,
      cols,
      rows,
    }),
  /** Send keystrokes (or paste) into the PTY's stdin. */
  terminalWrite: (terminalId: string, data: string) =>
    __TAURI_INVOKE<void>("terminal_write", { terminalId, data }),
  /** Resize the PTY when the xterm container changes size. */
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    __TAURI_INVOKE<void>("terminal_resize", { terminalId, cols, rows }),
  /** Kill the PTY's child process. */
  terminalKill: (terminalId: string) =>
    __TAURI_INVOKE<void>("terminal_kill", { terminalId }),
  /** Does Claude Code still have the conversation behind this uuid?
   *
   *  Asked before a resume is OFFERED. A session the user never sent a turn in
   *  leaves no conversation, so a cold pane's parked uuid is regularly for
   *  something that no longer exists — and accepting that offer used to kill
   *  the pane. `false` only when the absence is certain: anything unreadable
   *  answers `true` and leaves the offer standing. */
  claudeConversationExists: (claudeSessionId: string) =>
    __TAURI_INVOKE<boolean>("claude_conversation_exists", { claudeSessionId }),

  // RocTalk (voice dictation) ------------------------------------------------
  /** Begin recording. `inputDevice` is a name from `roctalkListInputDevices`;
   *  `""` (and null) mean the system default. A name that no longer matches
   *  anything falls back to the default rather than failing. */
  roctalkStartRecording: (inputDevice: string | null = null) =>
    __TAURI_INVOKE<void>("roctalk_start_recording", { inputDevice }),
  /** Stop recording, run `modelSize`'s Whisper model on the captured audio,
   *  return the raw transcript. */
  roctalkStopRecordingAndTranscribe: (modelSize: WhisperModelSize) =>
    __TAURI_INVOKE<string>("roctalk_stop_recording_and_transcribe", {
      modelSize,
    }),
  /** Toggle whether the Windows LL keyboard hook reacts to Caps Lock. */
  roctalkSetEnabled: (enabled: boolean) =>
    __TAURI_INVOKE<void>("roctalk_set_enabled", { enabled }),
  /** Whether `modelSize`'s model is on disk. Each size is tracked separately. */
  roctalkGetModelStatus: (modelSize: WhisperModelSize) =>
    __TAURI_INVOKE<RocTalkModelStatus>("roctalk_get_model_status", {
      modelSize,
    }),
  /** Download `modelSize`'s model into the app data dir. Every size is its own
   *  file and its own partial, so fetching one cannot damage another that is
   *  already there — including the one being dictated with right now. */
  roctalkDownloadModel: (modelSize: WhisperModelSize) =>
    __TAURI_INVOKE<void>("roctalk_download_model", { modelSize }),
  /** Every input device the audio host can see. `""` is not in the list — the
   *  renderer stores it to mean "system default". */
  roctalkListInputDevices: () =>
    __TAURI_INVOKE<string[]>("roctalk_list_input_devices"),

  // Global push-to-talk (mirror src-tauri/src/roctalk/ptt.rs) ----------------
  /** Bind `accelerator` (`"Alt+Space"`, `"Control+Shift+KeyD"`, …) as the
   *  global push-to-talk key, replacing any previous binding.
   *
   *  Rejects with the parser's own words when the string is not a shortcut, and
   *  with the OS's when another application already owns it — in that case the
   *  previous binding is put back, so a refusal never leaves PTT unbound.
   *
   *  On Windows this VALIDATES and stops: the low-level keyboard hook owns
   *  push-to-talk there (bare Caps Lock), and two sources would double-fire. */
  pttRegister: (accelerator: string) =>
    __TAURI_INVOKE<void>("ptt_register", { accelerator }),
  /** Release the global push-to-talk key. Succeeds when nothing is bound. */
  pttUnregister: () => __TAURI_INVOKE<void>("ptt_unregister"),
  /** The accelerator bound right now, as it was spelled when registered.
   *  `null` when nothing is — including always on Windows. */
  pttCurrent: () => __TAURI_INVOKE<string | null>("ptt_current"),

  // Filesystem (mirror src-tauri/src/fs_browse/mod.rs) -----------------------
  /** List a directory's immediate children. Refuses paths outside `projectRoot`. */
  fsReadDir: (projectRoot: string, path: string) =>
    __TAURI_INVOKE<DirEntryDto[]>("fs_read_dir", { projectRoot, path }),
  /** Read a UTF-8 text file (rejected if >5MB or non-UTF-8). The answer says
   *  whether a save would be allowed too — see `FileContentsDto.writable`. */
  fsReadFile: (projectRoot: string, path: string) =>
    __TAURI_INVOKE<FileContentsDto>("fs_read_file", { projectRoot, path }),
  /** Overwrite a file the editor already has open, atomically.
   *
   *  Same sandbox as `fsReadFile` and the same 5 MB cap, plus: it refuses a
   *  symlink, it refuses anything that is not already a regular file — it
   *  replaces what was opened, it does not create — and it refuses a file this
   *  process may not write, which temp + rename would otherwise replace
   *  silently (the rename needs a writable directory, not a writable file).
   *  The write is temp + fsync + rename, so a crash mid-save leaves the
   *  previous contents rather than half a file. Emits nothing; dirty state is
   *  the renderer's. */
  fsWriteFile: (projectRoot: string, path: string, contents: string) =>
    __TAURI_INVOKE<void>("fs_write_file", { projectRoot, path, contents }),

  // Named sessions (mirror src-tauri/src/sessions/mod.rs) --------------------
  /** Save `payload` under `name` in `~/.rocspace/sessions/<slug>.json`.
   *
   *  The payload is opaque to Rust apart from two documented top-level hints it
   *  copies into the file's meta: `workspaceName` and `paneCount`. Two names
   *  that slug the same address the same file, so this overwrites — see
   *  `sessionSlug` in `@/lib/savedSessions`, which is the renderer's copy of
   *  that rule and what the save prompt confirms against. */
  sessionSave: (name: string, payload: unknown) =>
    __TAURI_INVOKE<SavedSessionMeta>("session_save", { name, payload }),
  /** Every saved session, newest first. Reads each file's `meta` only. */
  sessionList: () => __TAURI_INVOKE<SavedSessionMeta[]>("session_list"),
  /** The payload saved under `name`. Shape is the renderer's business —
   *  `parseSavedSession` validates it on the way back in. */
  sessionLoad: (name: string) =>
    __TAURI_INVOKE<unknown>("session_load", { name }),
  /** Forget a saved session. Deleting one that is already gone succeeds. */
  sessionDelete: (name: string) =>
    __TAURI_INVOKE<void>("session_delete", { name }),

  // Git (the pane header's branch chip) --------------------------------------
  /** The branch `path` is on: a branch name, a 7-char sha when HEAD is
   *  detached, or null when the path is not inside a repository. Walks up
   *  from `path` and follows a worktree's `.git` file.
   *
   *  A one-shot question. Anything that also WATCHES must take its opening
   *  value from `gitWatch` instead — see `GitWatchHandle.branch`. */
  gitBranch: (path: string) =>
    __TAURI_INVOKE<string | null>("git_branch", { path }),
  /** Follow the HEAD of the repository `path` is in, emitting `git://branch`
   *  when it moves.
   *
   *  Returns the repository root the path resolved to, and the branch it was
   *  seeded with. Keep the root: it is what the events are labelled with and
   *  what `gitUnwatch` takes. Two panes in one project resolve to the same root
   *  and share one reference-counted watch. */
  gitWatch: (path: string) =>
    __TAURI_INVOKE<GitWatchHandle>("git_watch", { path }),
  /** Drop one watcher's interest in a repository — `root` as `gitWatch`
   *  returned it, not the path that was passed in. */
  gitUnwatch: (root: string) => __TAURI_INVOKE<void>("git_unwatch", { root }),

  // Git (the panel — mirror src-tauri/src/git/mod.rs) -------------------------
  // Every one of these shells out to the user's own `git` with an argv (never a
  // shell string), refuses a `repo` that is not absolute, refuses a file path
  // that is not repo-relative, and caps its output at 10 MB. Errors come back
  // as git's OWN message so the toast says what the command line would have.
  /** Branch, distance from upstream, and the three file lists. */
  gitStatus: (repo: string) =>
    __TAURI_INVOKE<GitStatus>("git_status", { repo }),
  /** Unified diff for one file — `staged` picks the index against HEAD rather
   *  than the working tree against the index.
   *
   *  An untracked file has no diff as far as git is concerned, so Rust
   *  synthesizes the all-additions one it would have once staged. Parse it with
   *  `parseUnifiedDiff` (`@/lib/gitDiff`) for Monaco's two sides. */
  gitDiff: (repo: string, path: string, staged: boolean) =>
    __TAURI_INVOKE<string>("git_diff", { repo, path, staged }),
  /** `git add` the paths — deletions included. An empty list is a no-op. */
  gitStage: (repo: string, paths: string[]) =>
    __TAURI_INVOKE<void>("git_stage", { repo, paths }),
  /** Take the paths back out of the index, leaving the working tree alone. */
  gitUnstage: (repo: string, paths: string[]) =>
    __TAURI_INVOKE<void>("git_unstage", { repo, paths }),
  /** Commit what is staged; resolves with the short sha. Hooks run (there is no
   *  `--no-verify`), and an empty message is refused before git is spawned. */
  gitCommit: (repo: string, message: string) =>
    __TAURI_INVOKE<string>("git_commit", { repo, message }),
  /** Local branches and remote-tracking ones, current flagged. A remote's own
   *  `HEAD` pointer (`origin/HEAD`) is not in the list — it names an entry that
   *  already is. */
  gitBranches: (repo: string) =>
    __TAURI_INVOKE<GitBranch[]>("git_branches", { repo }),
  /** Switch branches; `create` is `git checkout -b`.
   *
   *  Pass a LOCAL name. Handing this `origin/topic` would detach HEAD, which is
   *  never what clicking a branch means — the caller strips the remote prefix
   *  and lets git's own DWIM create the tracking branch. */
  gitCheckout: (repo: string, branch: string, create: boolean) =>
    __TAURI_INVOKE<void>("git_checkout", { repo, branch, create }),
  /** Add a linked worktree: a second checkout of this repository, on `branch`,
   *  at the absolute `path`. `createBranch` is `-b` — it fails rather than
   *  reusing a branch that already exists. */
  gitWorktreeAdd: (
    repo: string,
    path: string,
    branch: string,
    createBranch: boolean,
  ) =>
    __TAURI_INVOKE<void>("git_worktree_add", {
      repo,
      path,
      branch,
      createBranch,
    }),

  // RocPlan board (mirror src-tauri/src/rocplan/) -----------------------------
  /** Every card in `<projectPath>/.rocspace/plan.json`.
   *
   *  A project that has no board file yet answers with `[]` rather than
   *  failing — that is the state every project starts in. Entries Rust cannot
   *  understand (no id, a duplicate id, a status nobody has heard of) are
   *  skipped; a file that is not JSON at all rejects, because answering "no
   *  tasks" would let the next write replace something recoverable. */
  planRead: (projectPath: string) =>
    __TAURI_INVOKE<RocTask[]>("plan_read", { projectPath }),
  /** Replace the project's board. Creates `.rocspace/`; the write is atomic
   *  (temp + fsync + rename), so the MCP server reading it concurrently never
   *  sees half a file.
   *
   *  Does NOT come back as a `rocplan://changed` event: Rust records the stamp
   *  it wrote as the watcher's baseline, so the app's own saves do not echo. */
  planWrite: (projectPath: string, tasks: RocTask[]) =>
    __TAURI_INVOKE<void>("plan_write", { projectPath, tasks }),
  /** Follow the project's board file, emitting `rocplan://changed` when anyone
   *  ELSE writes it (an agent through the MCP server, an editor, a checkout).
   *  Reference-counted — pass the same string to `planUnwatch`, which is also
   *  the string the events are labelled with. */
  planWatch: (projectPath: string) =>
    __TAURI_INVOKE<void>("plan_watch", { projectPath }),
  /** Drop one caller's interest in a project's board. */
  planUnwatch: (projectPath: string) =>
    __TAURI_INVOKE<void>("plan_unwatch", { projectPath }),

  // Roc's brain (mirror src-tauri/src/roc_brain/mod.rs) ----------------------
  /** Run one reasoning turn through the Claude Code CLI in print mode.
   *
   *  `claude -p <prompt> --output-format json [--model <model>]`, with the
   *  binary resolved through a login shell (a Finder-launched app has almost no
   *  PATH), the cwd set to the OS temp directory (so no project's `CLAUDE.md`
   *  gets a say in how a request is routed), and a deadline after which the
   *  child is killed — `timeoutSecs` defaults to 60 and is clamped to 600.
   *
   *  Rejects with a sentence for the user: a missing CLI names the fix, a
   *  failed turn carries Claude Code's own last words. **Costs real money** —
   *  print mode re-sends Claude Code's system prompt every call — so the model
   *  is a setting (`settings.roc.brainModel`) and defaults to a cheap one. */
  rocThink: (
    prompt: string,
    model: string | null = null,
    timeoutSecs: number | null = null,
  ) =>
    __TAURI_INVOKE<RocThinkResult>("roc_think", { prompt, model, timeoutSecs }),
  /** Say `text` aloud through macOS `say`, replacing whatever was speaking.
   *
   *  Resolves when the speech ENDS — which is what lets a caller hold the
   *  "speaking" phase for exactly as long as there is sound, and what makes
   *  `rocStopSpeaking` resolve it immediately. `voice` is a name from
   *  `rocListVoices`; `null` (and `""`) mean the system default.
   *
   *  `rate` is words per minute (`say -r`). `null` leaves `say` to its own
   *  default, which is what a user who has never touched the slider should
   *  hear. Rust clamps anything else into 120–260 rather than trusting it — the
   *  caller is a hand-edited `settings.dat` as often as it is a slider.
   *
   *  Off macOS this resolves having done nothing, so no caller has to branch on
   *  the platform. */
  rocSpeak: (
    text: string,
    voice: string | null = null,
    rate: number | null = null,
  ) => __TAURI_INVOKE<void>("roc_speak", { text, voice, rate }),
  /** Stop the reply that is speaking. Succeeds when nothing is. */
  rocStopSpeaking: () => __TAURI_INVOKE<void>("roc_stop_speaking"),
  /** Every voice `say` offers, by name. Empty off macOS — and empty, rather
   *  than an error, when `say` cannot be run at all. */
  rocListVoices: () => __TAURI_INVOKE<string[]>("roc_list_voices"),
  // RocMind (mirror src-tauri/src/rocmind/) ---------------------------------
  /** Every Claude Code project scope under `~/.claude/projects` that holds at
   *  least one memory, sorted by label.
   *
   *  A machine with no `~/.claude/projects` answers `[]` rather than failing —
   *  that is the state of an install whose agents have not written a memory
   *  yet, and RocMind's empty state says it better than an error would. */
  mindScopes: () => __TAURI_INVOKE<MindScope[]>("mind_scopes"),
  /** One scope's memories, headers only — name, description, type, links,
   *  mtime, size. Bodies are NOT included: a scope is sixty files, and the
   *  tree needs none of them until one is opened. Sorted by name. */
  mindList: (scope: string) =>
    __TAURI_INVOKE<MindMemory[]>("mind_list", { scope }),
  /** One memory's contents, frontmatter included. `path` must be one Rust
   *  handed out — it is canonicalized and required to sit inside
   *  `~/.claude/projects`, and rejected otherwise. */
  mindRead: (path: string) => __TAURI_INVOKE<string>("mind_read", { path }),
  /** Follow a scope's memory directory, emitting `rocmind://changed` when a
   *  memory is written, edited or deleted there. Reference-counted — pass the
   *  same slug to `mindUnwatch`, which is also how the events are labelled.
   *
   *  A scope with no memory directory yet is a legal thing to watch: that is a
   *  project whose first memory has not been written, and it is exactly the
   *  one that should appear without a reload. */
  mindWatch: (scope: string) => __TAURI_INVOKE<void>("mind_watch", { scope }),
  /** Drop one caller's interest in a scope. */
  mindUnwatch: (scope: string) =>
    __TAURI_INVOKE<void>("mind_unwatch", { scope }),

  // Web preview (native child webview) --------------------------------------
  /** Create the preview webview if it doesn't exist (loading `url`); otherwise
   *  navigate it to `url` and reposition. Idempotent — calling it on every URL
   *  or bounds change is fine. */
  webPreviewShow: (
    url: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => __TAURI_INVOKE<void>("web_preview_show", { url, x, y, width, height }),
  /** Update the preview webview's position/size to track the host element. */
  webPreviewSetBounds: (x: number, y: number, width: number, height: number) =>
    __TAURI_INVOKE<void>("web_preview_set_bounds", { x, y, width, height }),
  /** Destroy the preview webview. Called when the user leaves Browser mode. */
  webPreviewClose: () => __TAURI_INVOKE<void>("web_preview_close"),
  /** Hide or show the existing preview webview WITHOUT destroying it. Used
   *  when the right-panel host shrinks to zero (collapse / drag-close) so the
   *  webview doesn't float over the rest of the app showing as a white
   *  rectangle. Hiding preserves page state — popping the panel back open
   *  resumes where the user left off. */
  webPreviewSetVisible: (visible: boolean) =>
    __TAURI_INVOKE<void>("web_preview_set_visible", { visible }),
};

// ---------------------------------------------------------------------------
// Agent + permissions
// ---------------------------------------------------------------------------

export type AgentType =
  "claude-code" | "codex" | "open-code" | "shell" | "custom";

export interface PermissionSettings {
  autoAcceptEdits: boolean;
  askBeforeRunningCommands: boolean;
  readOnlyMode: boolean;
  allowFileEdits: boolean;
  allowPackageInstalls: boolean;
  allowGitCommands: boolean;
}

export interface AgentConfig {
  /** Maps to Rust `agent_type` but serialized as "type" over IPC. */
  type: AgentType;
  taskPrompt: string | null;
  model: string | null;
  permissions: PermissionSettings;
  customArgs: string[] | null;
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export type TerminalStatus =
  "idle" | "running" | "awaiting_approval" | "error" | "complete" | "paused";

export type OutputStream = "stdout" | "stderr" | "system";

export interface TerminalOutputLine {
  id: string;
  ts: number;
  stream: OutputStream;
  text: string;
}

export interface TerminalSession {
  id: string;
  /** The workspace this session belongs to. Was `profileId` through schema v5;
   *  the v6 migration rewrites the field in place (a profile id becomes the
   *  workspace id it migrated into), so the value is stable across the bump. */
  workspaceId: string;
  name: string;
  agentConfig: AgentConfig;
  status: TerminalStatus;
  projectPath: string;
  commandHistory: string[];
  output: TerminalOutputLine[];
  createdAt: number;
  updatedAt: number;
  /** Child PID of the live PTY, or null when nothing is running. */
  pid: number | null;
  /** Claude Code `--session-id` of the live PTY, or null for every other agent
   *  type / a terminal that has never been spawned. Generated fresh in Rust on
   *  each spawn. Additive since schema v5 — older snapshots load with null. */
  claudeSessionId: string | null;
}

/** What `terminalSpawn` returns: the identity of the process just started. */
export interface SpawnResult {
  pid: number | null;
  claudeSessionId: string | null;
  /** The spawn asked to resume a conversation Claude Code no longer has, and
   *  started a fresh one instead — `claudeSessionId` is the NEW conversation.
   *
   *  A `--resume` at a conversation that was never written fails at launch and
   *  takes the pane down with it, which is what every un-prompted pane did on
   *  the next launch of the app. Rust starts fresh rather than let that happen;
   *  this is what stops the recovery from being silent. */
  conversationLost: boolean;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** The six accent slots a workspace can wear. Persisted verbatim, so these
 *  names are data — renaming one is a migration. Each maps to a theme token in
 *  `src/lib/accentColors.ts`, which is why a workspace re-colours with the
 *  active theme rather than carrying a literal. */
export type WorkspaceAccent =
  "violet" | "cyan" | "green" | "amber" | "rose" | "blue";

/** A project workspace: one directory, one pane tree, one accent.
 *
 *  Replaced the workspace/profile/group triple in Phase 2. Sessions are NOT
 *  held here — `useTerminalsStore.byId` stays the single source of truth and
 *  each session points back via `TerminalSession.workspaceId`. */
export interface Workspace {
  id: string;
  /** User-editable. Defaults to the `projectPath` tail, or "Workspace N". */
  name: string;
  /** Cycles through `WORKSPACE_ACCENTS` by creation order. */
  accent: WorkspaceAccent;
  /** `null` = no directory chosen; panes spawn in the user's home. */
  projectPath: string | null;
  /** How this workspace's panes are split. `null` means "not derived yet" —
   *  `ensurePaneTree` rebuilds a balanced tree from the workspace's live
   *  sessions on hydrate and on creation, so a snapshot whose tree failed
   *  validation still opens. */
  paneTree: PaneNode | null;
  focusedTerminalId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A directory the user has opened a workspace on. Offered by the new-workspace
 *  modal, newest first; pruned on load when the path has gone. */
export interface RecentProject {
  path: string;
  lastOpenedAt: number;
}

// ---------------------------------------------------------------------------
// Named sessions (mirror src-tauri/src/sessions/mod.rs)
// ---------------------------------------------------------------------------

/** A row in the saved-sessions list: enough to render it and to address the
 *  file again, never the session's contents. */
export interface SavedSessionMeta {
  /** The user's name for it, as typed. Pass this value straight back to
   *  `sessionLoad` / `sessionDelete` — Rust re-slugs it. */
  name: string;
  /** Milliseconds since the epoch. */
  savedAt: number;
  workspaceName: string;
  paneCount: number;
}

// ---------------------------------------------------------------------------
// RocPlan board (mirror src-tauri/src/rocplan/mod.rs)
// ---------------------------------------------------------------------------

/** Which column a card sits in. `cancelled` is a status rather than a deletion
 *  so a dropped card keeps its findings. */
export type RocTaskStatus =
  "todo" | "in_progress" | "in_review" | "complete" | "cancelled";

export type RocTaskPriority = "critical" | "high" | "medium" | "low";

/** One line of a card's append-only log. */
export interface RocTaskFinding {
  /** Milliseconds since the epoch. */
  at: number;
  /** An agent's chat name, `"you"` for the user, or `"mcp:<name>"` when it came
   *  in over the MCP server. */
  by: string;
  text: string;
}

/** A card on the board.
 *
 *  Lives in `<projectPath>/.rocspace/plan.json`, which is committed to the
 *  user's repository and written by both sides: this app through `planWrite`
 *  and an agent through the `rocspace-mcp` server. Last writer wins; the
 *  `rocplan://changed` event tells whichever side did not write. */
export interface RocTask {
  /** A ULID — mint it with `ulid()` from the `ulid` package, which is the same
   *  format Rust mints (`rocplan::new_task_id`), so neither side can tell which
   *  created a card. */
  id: string;
  title: string;
  /** Markdown-ish plain text. */
  description: string;
  status: RocTaskStatus;
  priority: RocTaskPriority;
  /** Matches a `TerminalSession.name` in the workspace; null = unassigned. */
  assignedTerminalName: string | null;
  /** Append-only. */
  findings: RocTaskFinding[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Roc's brain (mirror src-tauri/src/roc_brain/mod.rs)
// ---------------------------------------------------------------------------

/** What one `claude -p` turn produced. */
export interface RocThinkResult {
  /** The model's answer — the envelope's `result` field, verbatim. Parse it
   *  with `parseBrainReply` (`@/lib/rocBrain`), which tolerates fences and
   *  prose around the JSON. */
  text: string;
  /** The envelope's own flag. False on everything that resolves today — a
   *  failed turn rejects instead, because the "text" of an errored turn is an
   *  error message, and dispatching it would paste one into an agent. */
  isError: boolean;
  /** What the turn cost, when the envelope said. A few cents is normal. */
  costUsd: number | null;
  /** Wall clock, spawn to exit. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Filesystem browse types (mirror src-tauri/src/fs_browse/mod.rs)
// ---------------------------------------------------------------------------

export interface DirEntryDto {
  name: string;
  /** Absolute, canonicalized path. */
  path: string;
  isDir: boolean;
  size: number;
  /** True if the name starts with `.` — frontend dims these. */
  hidden: boolean;
}

export interface FileContentsDto {
  path: string;
  content: string;
  size: number;
  /** Monaco language id (e.g. "typescript", "rust"). null = let Monaco decide. */
  language: string | null;
  /** Whether `fsWriteFile` would be allowed to replace this file — asked of the
   *  kernel while it was being read, of the file AND of the directory the
   *  atomic write puts its scratch file in. False means the editor shows it
   *  read-only rather than handing out a buffer with nowhere to go. */
  writable: boolean;
}

// ---------------------------------------------------------------------------
// Events (emitted from the Rust PTY runtime — see src-tauri/src/pty/events.rs)
// ---------------------------------------------------------------------------

export const EVENT_TERMINAL_OUTPUT = "terminal://output";
export const EVENT_TERMINAL_STATUS = "terminal://status";

export interface TerminalOutputEvent {
  terminalId: string;
  lineId: string;
  ts: number;
  stream: OutputStream;
  text: string;
}

export interface TerminalStatusEvent {
  terminalId: string;
  status: TerminalStatus;
}

// ---------------------------------------------------------------------------
// Agent lifecycle (emitted from src-tauri/src/agents/events.rs)
// ---------------------------------------------------------------------------

/** Status derived from a Claude Code hook rather than guessed from output
 *  timing. Authoritative for terminals that have a `claudeSessionId`. */
export const EVENT_AGENT_STATUS = "agent://status";

export interface AgentStatusEvent {
  terminalId: string;
  status: TerminalStatus;
}

// ---------------------------------------------------------------------------
// Git (emitted from src-tauri/src/git_info/mod.rs)
// ---------------------------------------------------------------------------

/** A watched path's HEAD moved. Only fires on a *change* — the opening value
 *  comes from the `gitBranch` command. */
export const EVENT_GIT_BRANCH = "git://branch";

/** "Something `git status` would answer differently has happened here."
 *
 *  A superset of `git://branch` — every checkout is also one of these — and the
 *  stream the Git panel follows. Kept separate because the pane header's branch
 *  chip must NOT wake for it: an agent stages and commits constantly, and that
 *  would be a re-render of every pane header in the project, several times a
 *  minute, to set the string it already had.
 *
 *  Fires for anything that moves `.git`: staging, unstaging, committing,
 *  checking out, a merge or rebase in flight. NOT for a bare edit to a tracked
 *  file, which changes what `git status` says without touching `.git` at all —
 *  the window's focus handler is what covers that. */
export const EVENT_GIT_STATUS = "git://status";

export interface GitStatusEvent {
  /** Labelled exactly as `GitBranchEvent.root` is — the repository root Rust
   *  resolved, which is what `gitWatch` handed back. */
  root: string;
}

export interface GitBranchEvent {
  /** The repository this is about — the root `gitWatch` returned, NOT the path
   *  a pane asked about. One repository has one watch however many panes sit
   *  in it and however deep, so a pane's own cwd cannot identify it. */
  root: string;
  /** null = not a repository (any more). */
  branch: string | null;
}

/** What `gitWatch` hands back. */
export interface GitWatchHandle {
  /** The repository root the watched path resolved to. */
  root: string;
  /** The branch the watch was seeded with — the caller's opening value, and
   *  the same read Rust took as its baseline. null = not a repository.
   *
   *  Here rather than behind a separate `gitBranch` call because the two have
   *  to be one read: a checkout landing between them would leave the caller on
   *  the older value while Rust's baseline held the newer, and Rust only speaks
   *  when its baseline MOVES — so it would never correct anybody. */
  branch: string | null;
}

// ---------------------------------------------------------------------------
// Git panel (mirror src-tauri/src/git/mod.rs)
// ---------------------------------------------------------------------------

/** What happened to one file, in the vocabulary the panel draws.
 *
 *  Narrower than git's two-letter code on purpose: a typechange is a
 *  modification, a copy is a rename, and every unmerged combination is
 *  `conflicted` — the only thing the user can do about any of them is open the
 *  file. */
export type GitFileStatus =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileEntry {
  /** Repo-relative, and the SAME string `gitStage` / `gitDiff` take back — the
   *  round trip is the contract. For a rename it is the new path. */
  path: string;
  status: GitFileStatus;
  /** Where a renamed or copied file came FROM; absent otherwise. Not drawn —
   *  it is what lets the agent review recognise `git mv secrets/id_rsa
   *  notes.txt` as a credential despite its new, innocent name. */
  originPath?: string;
}

export interface GitStatus {
  /** The branch name, a 7-char sha when HEAD is detached, or null when even
   *  that could not be read. */
  branch: string | null;
  /** Commits this branch has that its upstream does not; 0 with no upstream. */
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  /** Every untracked FILE, not collapsed directories — a collapsed row could
   *  not be staged selectively or diffed. */
  untracked: GitFileEntry[];
}

export interface GitBranch {
  /** `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

// ---------------------------------------------------------------------------
// RocPlan (emitted from src-tauri/src/rocplan/watch.rs)
// ---------------------------------------------------------------------------

/** A watched project's `.rocspace/plan.json` moved — reload the board.
 *
 *  Only fires for writes the app did NOT make: `planWrite` hands Rust the
 *  stamp it produced, so a debounced save does not come back as a change one
 *  round trip later. */
export const EVENT_ROCPLAN_CHANGED = "rocplan://changed";

export interface RocPlanChangedEvent {
  /** The string that was passed to `planWatch`, not the canonical path Rust
   *  filed it under — this is the key `tasksByProject` is indexed by. */
  projectPath: string;
}

// ---------------------------------------------------------------------------
// RocMind (mirror src-tauri/src/rocmind/mod.rs)
// ---------------------------------------------------------------------------

/** One memory file, without its body. */
export interface MindMemory {
  /** The project slug the file lives under — the directory name Claude Code
   *  writes (`-Users-dev-Storefront`), which is the scope's identity
   *  everywhere: `mindList`, `mindWatch`, and the `rocmind://changed` payload. */
  scope: string;
  /** Absolute path to the `.md`. The handle `mindRead` takes. */
  path: string;
  /** Frontmatter `name`, or the filename stem when there is none. What
   *  `[[wikilinks]]` resolve against — not the filename, which can differ. */
  name: string;
  /** Frontmatter `description`, `""` when absent. A one-line summary written
   *  for ranking, which is why search weighs it above the body. */
  description: string;
  /** Frontmatter `metadata.type` — `user`, `feedback`, `project`, `reference`
   *  in this corpus — or `""`. A string rather than a union: it is somebody
   *  else's vocabulary, and a value we have not seen must still render. */
  memoryType: string;
  /** `[[targets]]` in body order, de-duped. Names, so they resolve against
   *  other memories' `name`. */
  links: string[];
  /** mtime, milliseconds since the epoch. */
  updatedAt: number;
  bytes: number;
}

/** One project's memory directory. */
export interface MindScope {
  slug: string;
  /** The slug decoded back to a real path, by walking the filesystem — the
   *  encoding maps `/`, `.` and spaces all onto `-`, so the string alone
   *  cannot be decoded. Best effort for a project that has been deleted. */
  projectPath: string;
  /** Last path segment: `Storefront`, or a worktree's own name (`v1.1`). */
  label: string;
  isWorktree: boolean;
  /** For a worktree, the repository it belongs to — what lets the tree nest it
   *  under that project rather than list it beside it. */
  rootPath: string | null;
  /** Memories in it, excluding the sibling `MEMORY.md` index. */
  count: number;
}

/** A watched scope's memory directory moved — re-read that scope. */
export const EVENT_ROCMIND_CHANGED = "rocmind://changed";

export interface MindChangedEvent {
  /** The slug that was passed to `mindWatch`. */
  scope: string;
}

// ---------------------------------------------------------------------------
// RocTalk events
// ---------------------------------------------------------------------------

export const EVENT_ROCTALK_PTT_DOWN = "roctalk://ptt-down";
export const EVENT_ROCTALK_PTT_UP = "roctalk://ptt-up";
export const EVENT_ROCTALK_AMPLITUDE = "roctalk://amplitude";
export const EVENT_ROCTALK_DOWNLOAD_PROGRESS = "roctalk://download-progress";

export type RocTalkModelStatus = "missing" | "downloading" | "ready";

/** The Whisper models RocTalk offers, smallest first. Mirrors `MODEL_SIZES` in
 *  `src-tauri/src/roctalk/whisper.rs`, which refuses anything else: the size
 *  becomes a filename and a URL down there, so the list is an allowlist rather
 *  than a suggestion. */
export const WHISPER_MODEL_SIZES = ["tiny.en", "base.en", "small.en"] as const;

export type WhisperModelSize = (typeof WHISPER_MODEL_SIZES)[number];

export interface RocTalkAmplitudeEvent {
  /** Root-mean-square of the most recent ~30 ms of audio, normalized 0..1. */
  rms: number;
}

export interface RocTalkDownloadProgressEvent {
  /** Which model this progress is about. Sizes download independently, so a
   *  listener showing one size's ring must ignore another's bytes. */
  modelSize: WhisperModelSize;
  received: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Defaults (single source of truth for factories + stores)
// ---------------------------------------------------------------------------

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  autoAcceptEdits: false,
  askBeforeRunningCommands: true,
  readOnlyMode: false,
  allowFileEdits: true,
  allowPackageInstalls: false,
  allowGitCommands: false,
};
