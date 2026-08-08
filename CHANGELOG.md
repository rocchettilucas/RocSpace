# Changelog

What changed in RocSpace, newest first. The app's "What's new" dialog reads the
top entry of this file, so every heading below is also a thing somebody saw.

**On version numbers.** `1.0.0` is the first tagged release, and the entry below
collapses the revamp into it. The `phase-*` entries under it are kept rather
than deleted: they are how the work was planned, built, reviewed and merged
(phases 0–5 landed as PRs #4–#9, one each, then phase 6), and each one is still
the truthful account of what changed on the day it says. Read `1.0.0` for what
RocSpace *is*; read the phases for how it got here.

Entry ids in brackets are stable — they are what the "What's new" dialog
remembers you have already read. Switching from phase ids to version numbers
does not re-announce anything anyone has already dismissed.

## [1.0.0] RocSpace, as a desktop app — 2026-08-08

The first tagged release, and the first one that installs: a signed-in-place
`.app` you keep in `/Applications` rather than a checkout you run from a
terminal. Everything below arrived across the revamp; this is what you get on
day one.

### Added

- **Panes that split the way you think.** Open a terminal, split it right
  (`⌘D`) or down (`⌘⇧D`), drag the divider, maximize one to fill the window and
  drop back. Up to sixteen. Each pane carries its own name — rename it to
  whatever the agent in it is doing — the git branch of its directory, and a
  status dot that reflects what the agent is actually doing, read from Claude
  Code's own lifecycle hooks rather than guessed from output.
- **Workspaces.** A project each, with their own panes, their own accent, and
  `⌘1`–`⌘9` to move between them. Quit and relaunch and they come back, agents
  resumed into the panes they were in.
- **RocPlan.** A board — To Do, In Progress, In Review, Complete — that lives in
  the repo as `.rocspace/plan.json`, so it travels with the project and shows up
  in review. Assign a card to a named agent and drag it to In Progress to send
  it; the agent moves its own card when it is done, through a bundled MCP server
  it is handed automatically.
- **Roc.** Ask for something in one sentence and Roc writes one tailored prompt
  per agent, shows you the plan, and sends nothing until you press Send. Talk to
  it by holding the push-to-talk key anywhere on the machine, or type. It
  answers out loud, and the orb reacts to your voice while you speak.
- **RocMind.** Every memory your agents write, mirrored into a browsable tree
  organised by the directory it came from — the memories in your projects are
  read where they already live and never moved.
- **Git and an editor, in the window.** Stage, diff, commit, switch branches,
  and create a worktree that opens as its own workspace. Open files with `⌘P`,
  edit them, save with `⌘S`. `⌘K` reaches everything.
- **Themes.** Dracula, Nord, Tokyo Night, Gruvbox, Catppuccin, Solarized and the
  rest, applied to the whole window — the terminals and the editor included, not
  just the chrome.
- **You are told when an agent finishes.** The pane outlines in green, a chime
  plays, and the bell fills. Click the notification and you land on that pane, in
  its workspace, highlighted — wherever you were.

### Fixed

Everything here is a defect that existed only in an installed app, and could
not fail in development. They were found by auditing the bundle itself rather
than the source, which is the only place they are visible.

- **Agents launch from the installed app.** A pane ran a bare `claude` through a
  non-interactive shell, which reads `~/.zshenv` and stops — while Claude Code's
  installer writes its PATH line into `~/.zshrc`. An app opened from Finder has
  no more path than `/usr/bin:/bin`, so every agent pane would have died with
  `command not found`, and only from the `.app`: run from a terminal it
  inherits a shell that already knows. Every agent CLI is now resolved to an
  absolute path first, and a pane whose CLI is missing says so instead of dying.
- **The app is validly signed.** With no signing identity configured the bundler
  skipped `codesign` entirely, leaving the linker's signature claiming sealed
  resources that were never written — which macOS reads not as unsigned but as
  *tampered with*, and refuses with "RocSpace is damaged." It now signs during
  bundling, which is the only moment the `.dmg` still sees the app.
- **The bundled app can use your microphone.** macOS terminates an app that
  opens an audio input stream without declaring why it wants one, so voice would
  have taken the whole app down on first use — while never once failing in
  development, where the request is attributed to the terminal that launched it.
- **The MCP server actually ships.** Staging it inside `tauri build` meant it
  was built with the bundle's own config and demanded the file it was about to
  produce; the release build had never completed, so RocPlan's agent-side tools
  had never been in an installed app.
- **The Git panel keeps up with your agents.** It refreshed on mount and on
  window focus, and the watcher behind it read `.git/HEAD` — the one file a
  commit never touches. An agent committing beside it left a pre-commit file
  list indefinitely, and the palette's "refresh" was a no-op.
- **Permission switches say what they do.** They rendered for every agent but
  only Claude Code's arguments carry them, so a Codex pane showed a safety
  control that looked set and reached nothing.
- **Dictation no longer disappears.** Speaking with the Roc widget hidden
  produced no orb, no text, and not even the fall-back-to-terminal path that
  exists for exactly that case.

## [phase-6] Roc's brain — 2026-08-05

### Added

- **Roc can be asked, not just told.** **Ask Roc** — beside Send in the command
  bar, first under a dictated sentence, and the sparkle on the floating widget —
  runs one turn of the Claude Code CLI in print mode (`claude -p …
  --output-format json`) with the live roster of every open session. Say "ask
  Rocky to fix the failing auth test and have Roxie update the login form" and
  it answers in one sentence and writes **one tailored prompt per agent**, each
  written to stand on its own.
- **The plan is proposed, not sent.** Every assignment is listed with the agent
  it is for and the instruction it would get, with **Send**, **Edit**, **Drop**
  and **Send all** — nothing reaches a terminal until you press one. Editing is
  the point: a model that understood most of a sentence writes a prompt that is
  mostly right. **Settings › Voice → Send without asking** turns that off and
  dispatches immediately; it is off by default, and says why when you turn it
  on.
- **Replies are spoken** on macOS, through the system voice, with a **Stop**
  button while Roc is talking and a voice picker (and a Test button) in
  Settings › Voice. Off macOS the reply is on screen only and nothing has to be
  configured.
- **A question is answered rather than acted on** — "what is everyone doing?"
  replies and dispatches nothing — and **a session name Roc invents is reported
  rather than sent to**.
- **Settings › Voice → Roc**: the brain's model (a cheap fast one by default,
  because every turn re-sends Claude Code's own system prompt and that is what a
  turn costs), whether replies are spoken, which voice, and auto-dispatch.

### Changed

- Every assignment still travels the ordinary fan-out, so readiness waiting, the
  per-pane queue, sanitizing, the rail's badges and the dead-pane skip are
  unchanged. What is new is the log: a whole Roc turn is **one** entry, marked
  **Roc** and reading back what you said, rather than one entry per agent — and
  pressing it sends each agent **its own instruction** again rather than the
  sentence, which is the only thing that would be worse than not re-sending it.
- Roc's "Thinking" phase means it, and means nothing else. It was a label a
  dictated sentence switched on and the next thing that happened switched off;
  it is now the reasoning turn and only that, so a transcript waiting on screen
  for you to press something leaves the orb alone. "Speaking" is a phase of its
  own — it is what the Stop button hangs off, whether Roc is proposing a plan or
  sending one.

### Fixed

- Nothing about a failed turn is silent: a missing CLI, a timeout, or an answer
  that was not a plan is shown on the stage and on the widget, with what to do
  about it — and the sentence you said is left where it was.

## [phase-5] Git, Editor & Finish — 2026-08-05

### Added

- **A Git panel**, the right panel's fourth mode: staged and unstaged files with
  their status letters, per-file and per-section staging, the selected file's
  diff in Monaco, and a commit box (**⌘⇧K** jumps to it from anywhere, **⌘↵**
  commits). The header carries the branch, ahead/behind counts, a box that
  switches or creates a branch, and **worktrees** — a second checkout on its
  own branch, which RocSpace offers to open as a workspace. Everything shells
  out to the user's own `git` with an argument vector and reports git's own
  message on failure; the panel re-reads on every mutation and every return to
  the window, because agents in the panes are changing the files it describes.
- **Ask an agent to review the staged diff** — handed to a pane as a review
  request, redacted first by path (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `*credentials*`, `*.p12` are never read) and by value (`KEY=` / `TOKEN=` /
  `SECRET=` / `PASSWORD=` assignments are masked), capped at 200 KB, with the
  prompt saying what was withheld.
- **A writable editor**: **⌘S** saves the current file atomically through the
  same sandbox every other file read goes through, dirty tabs show a dot instead
  of their close button, closing one asks, and save-all / revert / close are
  palette actions. When a file changes on disk under unsaved work — an agent in
  the pane next door — the editor asks **Keep mine** or **Take theirs** rather
  than picking one.
- **Go to file (⌘P)** — fuzzy search over a walked index of the project,
  skipping `.git`, `node_modules`, `target` and `dist`.
- **Command palette (⌘K)** — every action in the app, by name. Fuzzy search over
  titles, keywords and group headings; ↑/↓ to move, Enter to run, Escape to
  close. Seeded with the workspace, pane, right-panel, RocPlan, Roc, voice and
  Settings actions, one "Switch to …" per open workspace, and one entry per
  theme; Git and the editor register theirs. Areas contribute their own actions
  through
  `src/lib/commands/registry.ts`, so a surface that is not built contributes
  nothing rather than leaving a dead row behind.
- **Zoom (⌘+ / ⌘− / ⌘0)** — scales the whole window by moving the root font
  size, persisted in settings, with a control in Settings › Appearance.
  Terminals keep their own font size (Settings › Terminal): how much scrollback
  fits is a different question from how big the chrome is.
- **"What's new"** — a dialog driven by this file, shown once per entry and
  reachable any time from the command palette and Settings › About.
- **Documentation that is true** — `README.md` rewritten from scratch against
  what the app is after six phases, this changelog, and `docs/user-guide.md`.

### Changed

- Every remaining `window.confirm` is now a RocSpace dialog on `ModalShell` —
  closing a running pane, closing a workspace with running panes, deleting a
  saved session, replacing one, deleting a RocPlan card. The native sheet was
  unthemed, could not mark a destructive answer as destructive, and blocked the
  whole webview (PTY readers included) for as long as it was up.
- `ModalShell` now keeps a queue of open dialogs, so a confirmation asked from
  inside another dialog gets Escape and the Tab trap to itself instead of
  sharing them with the dialog underneath.
- The long-dead `isCommandPaletteOpen` scaffolding in `stores/ui.ts` is wired
  rather than replaced — and, for the first time, counted as a blocking modal,
  so no chord acts on a pane behind the palette.

## [phase-4] Roc Orchestrator + Voice — 2026-08-05

### Added

- **Roc**, the orchestrator you talk to: a floating widget (draggable, animated
  orb, live transcript) that expands into a full view — a sessions rail listing
  every agent across every workspace, a stage with the transcript and dispatch
  log, and a **live interactive terminal** bound to the selected agent's real
  PTY.
- **Multi-agent fan-out**: say one thing to several agents at once. Targets come
  from `@name` tokens in the message, from the rail's checkboxes, or from
  "Broadcast" across the active workspace. Busy panes queue and are dispatched
  when they go idle, with a per-pane badge saying what each one still owes.
- **macOS push-to-talk** through the global-shortcut plugin, default `Alt+Space`
  and rebindable in Settings › Voice. Windows keeps its `WH_KEYBOARD_LL` Caps
  Lock hook; the DOM fallback listener stays for keys the hook cannot see.
- **Settings › Voice**: push-to-talk key capture, Whisper model size, input
  device, and where a finished transcript goes — the focused terminal, or Roc's
  command bar.

### Changed

- `useRocTalk` is one pipeline with two sources instead of two near-identical
  copies.
- Every surface that writes to an agent now goes through
  `src/lib/agentDispatch.ts` (sanitize → bracketed paste → wait for idle →
  send), so a card, a broadcast and a dictated line all reach a pane the same
  way.

## [phase-3] RocPlan — 2026-08-05

### Added

- **RocPlan**, a kanban board per project, stored as `.rocspace/plan.json` in
  the project directory so it travels with the repo. Columns To Do / In Progress
  / In Review / Complete, plus Cancelled behind a toggle. Cards carry a
  priority, an assigned agent, timestamps and an append-only findings log.
  Drag with the mouse or move with ←/→.
- **Drag-to-dispatch**: dropping a card in In Progress resolves the assigned
  agent's pane, waits for it to be idle, and sends it a structured prompt. A
  toast says which agent picked it up, with a "Watch it work" jump when you are
  somewhere else.
- **Auto-advance**: when the dispatched agent's turn ends, its card moves to In
  Review and the notification bell rings.
- **`rocspace-mcp`**, a local stdio MCP server handed to Claude panes
  automatically, exposing `rocplan_list_tasks`, `rocplan_get_task`,
  `rocplan_create_task`, `rocplan_update_task_status` and
  `rocplan_append_finding` — so an agent can file discovered work and move its
  own card.

### Fixed

- The board file is written atomically under an advisory lock and watched for
  external edits, so two writers (the app and an agent through MCP) stop losing
  each other's changes.

## [phase-2] Workspaces & Sessions — 2026-08-05

### Added

- **Multiple workspaces**: a sidebar tablist with per-workspace accent, pane
  count and drag-to-reorder; ⌘T for a new one, ⌘1–⌘9 to switch. Background
  workspaces stay live — their PTYs keep running and their output keeps
  buffering — so switching back replays into a fresh terminal.
- **New Workspace modal** with 1 / 2 / 4 / 6 / 8-pane templates, a real
  directory picker, agent multi-select, and recent project directories.
- **Named sessions**: ⌘⇧S snapshots a workspace (pane tree, per-pane agent
  config, names, working directories) to `~/.rocspace/sessions/<name>.json`;
  restore it from the sidebar footer or Settings › History.
- **Agent resume**: a Claude pane that was mid-conversation when the app quit is
  offered its conversation back on the next launch (`claude --resume`), rather
  than starting cold. Spawns are bounded at four at a time.
- **Settings › History**: saved sessions, and the panes that failed to start.

### Changed

- The persisted snapshot is schema v6; the single-workspace + profiles model of
  v5 migrates into the first workspace.
- `RocLaunch`, the four-step setup wizard, is gone — the New Workspace modal
  asks the same questions in one dialog.

## [phase-1] Terminal Grid 2.0 — 2026-08-04

### Added

- **Split panes**: each workspace holds a binary split tree instead of five
  fixed layouts. ⌘D splits right, ⌘⇧D splits down, ⌘N opens a pane beside the
  focused one, ⌘W closes it; every divider is draggable and its ratio persists.
  Up to 16 panes per workspace.
- **Pane chrome**: a 28px header per pane with a status dot, a renameable name
  from the roc-name pool (Rocky, Rocco, Roxie…), the agent type and working
  directory, a **git branch chip** that follows checkouts, and split / maximize /
  close actions.
- **Real agent invocation**: `agents/command.rs` builds a per-agent argv —
  model, permission mode, initial prompt, session id — instead of typing a
  command into a shell. Custom agents get their arguments parsed as an argv,
  never as a shell string.
- **Hook-driven status for Claude Code**: a per-spawn settings file wires
  SessionStart / Stop / Notification hooks to a JSONL file that Rust tails, so a
  pane's running / waiting / idle state is reported rather than guessed from
  silence.

### Changed

- Terminals render through the WebGL addon with a DOM fallback on context loss,
  and PTY output is batched per animation frame with a per-frame budget so
  eight streaming panes stay smooth.

### Fixed

- Chunk boundaries emitted by Rust are UTF-8 safe, so a multi-byte character
  split across two reads no longer arrives as garbage.

## [phase-0] Foundation — 2026-08-04

### Added

- **Theme engine**: ten themes (RocSpace Dark, Dracula, Black, Gruvbox Dark,
  Cyber Wave, One Dark Pro, Tokyo Night, Nord, Light, Solarized Light) built
  from one record of semantic tokens each. Terminals, the Monaco editor and the
  native window frame all derive from the same tokens and re-theme live.
- **Settings**, as an overlay over the dock rather than a modal: Appearance,
  Terminal, Agents, Voice, Shortcuts, History, About. Stored in its own
  `settings.dat` so it survives anything that happens to the workspace snapshot.
- ESLint (flat config), Prettier, `cargo clippy -D warnings` and a GitHub
  Actions workflow running all of it.

### Fixed

- PTY children are killed on app exit — quitting no longer left agent processes
  running.
- One source of truth for terminal sessions (`useTerminalsStore`), one place for
  every cap (`src/lib/limits.ts`), and the dead mock-agent runtime removed.

## [0.1.0] — 2026-05-08

The app the revamp started from: a single-workspace grid of real PTY terminals
running Claude Code, Codex, OpenCode or a plain shell, with RocTalk push-to-talk
dictation (local Whisper), a Monaco editor pane, a native-webview browser
preview, and workspace state persisted across restarts. Windows-first.
