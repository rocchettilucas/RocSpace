# RocSpace — user guide

Everything the app does, in the order you are likely to meet it. `README.md` is
the pitch and the build instructions; this is the tour.

Keys are written the way macOS spells them. RocSpace binds `⌘` and never `⌃`, on
purpose: `Ctrl-D` is end-of-input and `Ctrl-K` is kill-line in every shell these
panes run, so binding either would be a destructive misfire. Windows has no
chord map yet.

**Contents**

1. [The first launch](#the-first-launch)
2. [Workspaces](#workspaces)
3. [Panes](#panes)
4. [Agents](#agents)
5. [Saved sessions](#saved-sessions)
6. [RocPlan — the board](#rocplan--the-board)
7. [RocPlan for agents (MCP)](#rocplan-for-agents-mcp)
8. [Roc — the orchestrator](#roc--the-orchestrator)
9. [RocTalk — voice](#roctalk--voice)
10. [The right panel](#the-right-panel)
11. [Git](#git)
12. [The editor](#the-editor)
13. [The command palette](#the-command-palette)
14. [Settings](#settings)
15. [Every shortcut](#every-shortcut)
16. [Where your data lives](#where-your-data-lives)
17. [When something goes wrong](#when-something-goes-wrong)

---

## The first launch

RocSpace opens on an empty state with nothing but an invitation to make a
workspace. **⌘T** — or the button — opens the New Workspace dialog. Everything
else in the app hangs off having one.

The "What's new" dialog appears once per release entry. Closing it is the
acknowledgement; you can read it again from Settings › About or by searching
"what's new" in the command palette.

## Workspaces

A workspace is one project directory, one arrangement of panes, one accent
colour, and the pane you were last looking at. The sidebar lists them.

- **⌘T** — new workspace. Pick a directory, a pane template (1, 2, 4, 6 or 8),
  and which agents to fill it with; the agents cycle across the panes. Recent
  directories are offered.
- **⌘1** … **⌘9** — switch to the *n*th row of the sidebar. A digit past the end
  does nothing rather than clamping to the last row: pressing ⌘7 with three open
  is a miss, and landing somewhere unrelated is worse than landing nowhere.
- **↑ / ↓** in the sidebar move between workspaces and switch as they go;
  **Enter** or **Space** on a focused row switches to it.
- Drag a row to reorder. Double-click the name to rename it. The coloured dot
  opens the accent picker.
- The **×** closes a workspace. If any of its panes are still running it asks
  first, and says how many.

A workspace you are not looking at is not asleep: its PTYs keep running and its
output keeps buffering into a ring buffer. Coming back replays it into a fresh
terminal, so nothing is lost and nothing is duplicated.

The topbar's centre says which workspace you are in and which directory it is
pointed at — or which surface has taken the main area, if it is RocPlan.

## Panes

Each workspace holds a **split tree**. There are no fixed layouts: every split is
a real division you can drag, and every ratio is remembered across a quit.

| Key | What it does |
| --- | --- |
| **⌘D** | Split the focused pane to the right |
| **⌘⇧D** | Split the focused pane downwards |
| **⌘N** | New pane beside the focused one (the same thing as ⌘D) |
| **⌘W** | Close the focused pane |

Closing a pane that is still running asks first. Closing an idle or finished one
does not — that is not a decision worth a dialog.

Sixteen panes per workspace is the cap. When there is no pane at all, ⌘D opens
the first one rather than doing nothing.

**The pane header** carries, left to right: a status dot (which pulses while the
agent is working), the pane's name, its agent type and the tail of its working
directory, a git branch chip, and buttons for split-right, split-down, maximize
and close. Double-click the name to rename it; names are unique within a
workspace, and a name you re-use gets a number rather than being refused.

Names come from a pool — Rocky, Rocco, Roxie, Rocket, Rockwell… — one per
workspace, so every project starts at Rocky. They are how you address a pane in
Roc (`@Rocky`) and on a RocPlan card.

**Maximize** hides the tree and gives one pane the whole dock. The tree
underneath is untouched; it is somewhere you pop in and out of.

A **file path in terminal output is clickable**, and opens in the right panel's
editor at the line.

## Agents

Four kinds, plus custom: **Claude Code**, **Codex**, **OpenCode**, and a plain
**Shell**.

What a pane launches is resolved as a program plus an argument list — model,
permission mode, an initial task prompt, a session id — and every word is quoted
before it is run, so nothing you type in a prompt or in a custom agent's
arguments can be re-read as shell syntax. A custom agent's arguments stay an
argument list rather than being joined into a string and split again.

**Status.** For Claude Code panes the status is reported by the CLI itself:
RocSpace hands each spawn a settings file that wires Claude's SessionStart, Stop
and Notification hooks to a log it tails. So "running", "awaiting approval" and
"idle" are facts, not guesses. Other agents fall back to a quiet-for-a-while
heuristic.

**When an agent finishes.** Every pane whose agent ends a turn lights up green
and dings once — the one you are watching included. Focusing a pane puts its
glow out. Watching a pane used to withhold both, on the theory that you are
already reading the answer; with four panes working, the one that finished is
just as often the pane your cursor happens to be in, and a turn you missed is
not recoverable. Turning the sound off is a setting; being told late is not.

A dialog is the one thing that quiets it: a pane under Settings, a
confirmation, ⌘K or any other modal still lights up and still files a
notification, but its ding waits until you dismiss whatever is on top of it.
What a pane is *stopped* on is never held back that way — a permission prompt
and a crash sound through a modal, and through a turn that ended a moment
earlier.

An agent that keeps working through turns you are not there for stays green
without adding to the bell each time: one notification per pane until you go
back to it. The sound is not pooled with it — the list is a record, and a
readable one needs no repeats, but every finished turn is an event and each
one rings. Two turns inside three seconds are one ding.

Only Claude Code panes have a turn to finish, for the reason above: the boundary
comes from that CLI's hooks. Codex, opencode and shell panes report no such
thing, so nothing new happens in them.

**Changing an agent's configuration** (right panel › Inspector) changes what the
*next* launch will be. The process already running was started with the old
arguments and cannot be told otherwise — the Inspector says so, and offers the
restart that would apply the change.

**Launch all / Stop all** are in the topbar, and act on the panes on screen.

## Saved sessions

**⌘⇧S** saves the active workspace under a name: its pane tree, each pane's agent
configuration, the pane names, and the working directories. Files go to
`~/.rocspace/sessions/`.

The name becomes a filename, so the dialog shows you which file it will be, and
asks before writing over one that is already there — two names that reduce to the
same file are the same session.

Restore from the sidebar footer or Settings › History. A restored session opens
*beside* whatever you already have; it never replaces it.

Restored panes with a Claude conversation waiting start cold on purpose — you are
offered the resume rather than having it happen to you.

**On relaunch**, panes that were running when you quit come back. A Claude pane
that was mid-conversation is offered that conversation (`claude --resume`); the
rest start fresh. Spawns are bounded at four at a time so sixteen panes do not
all fork at once.

## RocPlan — the board

**⌘⇧P** swaps the main area for the active project's board, and again to go back.
The terminals stay running behind it.

Columns are **To Do**, **In Progress**, **In Review**, **Complete**, with
**Cancelled** behind a toggle.

A card has a title, a description, a priority (critical / high / medium / low), an
assigned agent, timestamps, and an append-only **findings** log — the record of
what was discovered while the work was done.

- Click a card to edit it, or **Enter** / **Space** on a focused one.
- **← / →** move a focused card to the previous or next column, across the columns
  that are on screen — so a card cannot walk into Cancelled while it is hidden.
- Drag with the mouse for the same thing.

**The board is a file in your repo**: `<project>/.rocspace/plan.json`. Commit it
and the plan travels with the branch. RocSpace writes it atomically under a lock
and watches it for changes, so an agent editing it at the same time does not lose
your edit or vice versa.

**Dispatch.** Dropping a card into **In Progress** hands it to an agent: RocSpace
finds the assigned pane, waits for it to be idle, and sends it a prompt built
from the card. A toast says who picked it up, with a *Watch it work* button when
you are somewhere else. When that agent's turn ends, the card moves itself to **In
Review** and the notification bell rings — you decide when it is Complete.

## RocPlan for agents (MCP)

Claude panes are handed a local MCP server (`rocspace-mcp`) pointed at the same
board file, with five tools:

| Tool | What an agent does with it |
| --- | --- |
| `rocplan_list_tasks` | See the board |
| `rocplan_get_task` | Read one card in full, findings included |
| `rocplan_create_task` | File work it discovered |
| `rocplan_update_task_status` | Move its own card along |
| `rocplan_append_finding` | Record what it learned |

Which turns the board from a dashboard into a protocol: you and the agents are
looking at the same list, and both of you can write to it.

## RocMind — every memory your agents wrote

**⌘⇧M** swaps the main area for RocMind, and again to go back. The terminals stay
running behind it, and there is a **RocMind** row in the sidebar beside RocPlan.

Claude Code already writes memories: short markdown files, one per thing worth
remembering, under `~/.claude/projects/<project>/memory/`. RocMind reads them
**in place**. Nothing is imported, copied or converted — Claude Code owns those
files and is still writing them, so a RocSpace copy would be wrong within a day.

**Left: a folder per project.** Open one to see its memories. A project's git
worktrees are nested underneath it as sub-folders, which is the part Claude Code
does not do for you: a memory written inside `.claude/worktrees/v1.2` lives in its
own scope and is invisible to the repository it was made from. RocMind puts them
under one roof and counts them together. Which folders you left open is
remembered.

**Right: the memory.** Its one-line description as a subtitle, its type as a chip
(`project`, `feedback`, `user`, `reference`), the body rendered as markdown, and
then the graph from both directions — the `[[links]]` it makes, and the memories
that link back to it. Every chip is clickable.

**Search** ranks a title hit above a description hit above a body hit, and breaks
ties by recency. That is not a guess about what you meant: every memory carries a
`description` written to be ranked against. It searches the project you last
opened; **All projects** widens it to everything.

**The graph tab** (in the header, beside the search box) draws the same corpus as
a picture — a node per memory, sized by how many memories link to it, coloured by
type; an edge per link. It takes the whole surface rather than the folder rail:
sixty memories and a hundred links need the room. The most-linked-to memories are
named where there is space for the name; hover a node to dim everything more than
two hops away and label its neighbours; type in the search box and the matches
pulse; click one to open it beside the picture. The layout is remembered, so
coming back to the tab shows the same picture rather than rearranging it.

**Live.** RocSpace watches the memory directories of every open workspace — and
of their worktrees. A memory an agent writes in one of your panes appears here
without a reload, and if you are looking somewhere else a toast says so with a
*Read it* button.

## RocMind for agents (MCP)

The same `rocspace-mcp` server that serves the board also serves the project's
memories, **but only when the project has some**:

| Tool | What an agent does with it |
| --- | --- |
| `mind_search` | Find memories by words, best match first |
| `mind_read` | Read one in full, by name |
| `mind_backlinks` | See what links to one — usually where the reason is written |

These are **read-only**. Agents create memories through Claude Code's own memory
mechanism; two writers racing for the same file would help nobody. What the tools
add is reach: the search covers the project's worktree scopes too, so an agent in
the main repository can find what an agent in a worktree wrote down.

## Roc — the orchestrator

Roc is the floating widget in the corner and the view it expands into. **⌘⇧R**
expands and collapses it; the topbar's audio button shows and hides the widget.

The expanded view is three regions, and the dividers between them are yours to
drag:

- **The sessions rail** — every agent session in every workspace, with its name,
  its workspace, its status, and a checkbox.
- **The stage** — the orb, what Roc last heard, the box you compose in, and the
  log of everything sent.
- **The live terminal** — the selected agent's real PTY, interactive. You can type
  into it. It is the same session the pane shows, not a mirror of it.

### Reading the orb

The orb is the one thing on the stage you can read without reading. It is a ring
of spokes whose lengths are **the last two seconds of your microphone** — newest
at twelve o'clock, advancing clockwise — so your voice draws it and the silences
between words are visible as it decays.

The four states differ in what they *do*, not in what colour they are:

| State | What you see | What it means |
| --- | --- | --- |
| Idle | Nothing moves | Roc is not doing anything |
| Listening | The ring follows your voice; the core breathes | The microphone is open |
| Thinking | The ring goes even and one wave sweeps it | It has stopped hearing you — a turn is out, or Whisper is transcribing |
| Speaking | An arc grows from twelve o'clock, pulsing at the syllable rate; the rest of the ring is flat | Roc is reading its reply aloud, and the arc says how far through it is |

The phase line under it names the state in words, and that line is what a screen
reader is told; the orb itself is decorative. A silent microphone still breathes,
so "nobody is talking" and "this is broken" do not look the same.

Nothing animates while Roc is idle — a decoration turning forever repaints behind
every terminal you have open — and nothing animates at all if your system asks
for reduced motion, which gets one still picture per state instead.

### Saying one thing to several agents

Three ways to aim a message, and they combine:

1. **`@name` tokens** in the text — `@Rocky @Roxie the auth test is failing`. The
   composer tells you who it would reach before you send it, and says so when a
   name matches nothing.
2. **Checkboxes** in the rail — tick as many sessions as you like, across
   workspaces.
3. **Broadcast** — every pane in the active workspace.

**Enter** sends. **⌘Enter** and **⇧Enter** insert a newline instead: the common
message is one sentence, and the rare multi-line one costs one modifier.

A pane that is busy **queues** the message and receives it when it goes idle; its
row shows what it still owes, and you can cancel a queued message from there.

Everything sent goes into the log under the composer, with who it went to. Click
an entry to send it again — to the same panes, in the same workspace.

### Asking Roc instead of telling it

**Ask Roc** — the button beside Send, the first button under a dictated sentence,
and the sparkle on the floating widget — hands what you said to Roc's brain
rather than to the agents. It runs one turn of the **Claude Code CLI** with the
live roster of your sessions, and comes back with:

- **a reply**, one sentence, shown on the stage and on the widget — and read
  aloud on macOS, with a **Stop** button while it is speaking;
- **an assignment per agent**, each one a complete instruction written for that
  agent, listed with **Send**, **Edit**, **Drop** and **Send all**.

Nothing reaches a terminal until you press one of those. That is the whole point:
a model that understood most of your sentence writes a prompt that is mostly
right, and editing the last word is faster than saying it all again. Turn
**Settings › Voice → Send without asking** on and the assignments go the moment
Roc has decided — quicker, and nothing to take back if it misheard you.

Two things it deliberately does not do:

- **A question is answered, not acted on.** "What is everyone doing?" gets a
  reply and no dispatch.
- **A name it invented is reported, not sent to.** If Roc names a session that is
  not open, that part of the plan is dropped and a notice says which.

Every assignment travels the same road a typed message does — a busy pane queues
it, a pane whose agent has exited is skipped and named. A whole turn is one entry
in the log, marked **Roc** and reading back **what you said**; clicking it sends
each agent its own instruction again, not that sentence.

**It costs money.** Each turn is a `claude -p` call, and Claude Code re-sends its
own system prompt every time — so a two-agent routing question is a few cents on
the cheap fast model Settings › Voice defaults to, and several times that on a
frontier one. Claude Code has to be installed and logged in; when it is
not, the stage says so in words rather than going quiet.

### How Roc talks

Settings › Voice › **Roc's manner** decides how that one reply is *worded*. It
does not change the voice.

- **Plain** — an ordinary, helpful sentence. This is the default, and it is what
  Roc has always said; upgrading never changes what you already hear.
- **Butler** — at most one sentence, understated and dry, no exclamation marks
  and no enthusiasm. *"Rocky has finished the auth test, sir — two files
  changed."* rather than *"Great news! I sent that to Rocky!"* It may call you
  sir, sparingly.

The manner shapes the reply and **nothing else**. The instruction each agent
receives is a plain instruction to a command-line tool either way — an agent
spoken to in character is a worse agent, and "Rocky, if you would be so kind" is
noise in front of the work.

Two controls sit with it:

- **Roc's voice** lists **the voices macOS provides** — exactly what `say -v ?`
  reports on your machine. RocSpace ships no voice of its own, licenses none and
  imitates nobody; if you want more, they are in System Settings ›
  Accessibility › Spoken Content, and they show up here once installed. A voice
  in your settings that this machine has never heard of is kept and marked *(not
  installed)*, so carrying settings between machines does not lose it.
- **Speaking rate** is words per minute, 120 to 260, shown beside the slider.
  Left alone it is 175 — what `say` does on its own.

**Audition** reads one line in the voice, rate and manner as they stand right
now. The line differs per manner on purpose: hearing the same sentence twice
would only tell you about the voice, which is the one thing the manner picker is
not choosing. It works whether or not spoken replies are switched on — that is
usually how you decide.

## RocTalk — voice

Hold the push-to-talk key, speak, release. The audio is transcribed by a Whisper
model on your machine; nothing is uploaded.

- **The key** is `⌥Space` by default and rebindable in Settings › Voice. On
  Windows it is Caps Lock, held by a low-level keyboard hook that swallows the
  key, so the OS never toggles caps state or the light.
- **The model** (`tiny.en`, `base.en`, `small.en`) is downloaded on first use —
  `base.en` is about 142 MB. Dictation is inert until it is on disk, and the
  widget shows the download.
- **Where it goes** is the switch on the widget, described next.

### The two modes

The Roc widget carries a two-way switch, always on screen, and it decides what
holding the key does:

- **Dictate** — types what you say into the focused pane. This is the default,
  and it is what RocTalk has always done.
- **Talk to Roc** — the words land on Roc's stage as a draft you can aim and
  edit, or hand to Roc's brain, before anything is sent.

One click either way. The same choice is in the command palette ("Switch Roc to
dictation" / "Switch Roc to conversation", and only the one you are not in is
ever offered) and in Settings › Voice; all three write the same setting, so
there is one answer to which mode you are in rather than two that can drift.

While the key is held, the widget's phase line says which mode you are in and,
in Dictate, **names the pane** — *Listening — dictating to Rocky*. That is the
moment it matters: the mode is a setting you changed once and a sentence you are
saying now.

Talking to Roc is the safer route for anything that fans out. Whisper mishears,
and a broadcast cannot be taken back — "delete the migrations" is one wrong word
away from something five agents heard at once. Roc makes you press the button.

## The right panel

A segmented control at its top switches between four modes; the topbar's
right-hand button collapses the whole panel.

**Inspector** — the focused pane's agent, model, permission toggles and task
prompt. Edits apply to the next launch (see [Agents](#agents)).

**Browser** — a preview of whatever you are running locally. It is a native
webview rather than an iframe, so sites that refuse to be framed still load.

**Editor** — Monaco over a file tree of the active project, and you can type in
it. See [The editor](#the-editor).

**Git** — the working tree of the project this workspace is pointed at. See
[Git](#git).

## Git

The Git panel is about **the active workspace's project directory** — not the
focused pane's working directory. A pane can be `cd`'d anywhere, and a panel
that followed it would swap repositories under a half-typed commit message.

It re-reads on every change it makes, when it opens, and every time you come
back to the window. That last one matters here more than anywhere else in the
app: the files it is describing are being edited by agents in the panes next
door.

**The header** carries the current branch, how many commits you are ahead and
behind, and three buttons — switch or create a branch, new worktree, ask an
agent to review.

**The files** come in two lists. *Staged* and *Changes* (which includes
untracked files), each row a status letter — `M`odified, `A`dded, `D`eleted,
`R`enamed, `U`ntracked, `C`onflicted — and a name. Click a row to see its diff;
the **+** / **−** on a row stages or unstages that file, and the button on the
section heading does the whole list at once.

**The diff** is Monaco, inline rather than side by side: the panel is a column,
and two viewports inside it would wrap every real line.

**Committing.** Type a message in the box at the bottom and press **⌘↵**, or the
Commit button. Enter on its own is a newline — a commit message has a subject
and a body. **⌘⇧K** from anywhere opens this panel and puts the cursor in that
box, expanding the panel first if it was collapsed. The button is inert until
something is staged and the message is not empty.

**Branches.** The branch name in the header opens a filter box: type to narrow
the list, Enter checks out the first match, and a name that matches nothing is
offered as a new branch.

**Worktrees.** A worktree is a second checkout of the same repository, on its
own branch, in its own directory — one object store, no clone, no stashing.
RocSpace suggests a sibling directory (`…/rocspace` + `feature/x` →
`…/rocspace-feature-x`), and when it is created it offers to **open it as a
workspace**. That is the point of the feature: three agents on three branches is
three workspaces.

Everything here runs the `git` on your `PATH`, as an argument list. When a
command fails you get git's own sentence — "nothing to commit", "your local
changes would be overwritten" — because that is the one you can search for.

### Asking an agent to review

**Ask an agent to review** picks a pane and hands it the **staged** diff, framed
as a review — "report what you find, do not edit any files".

That diff leaves your machine: the CLI on the other end sends its context to a
model. So it is redacted before it is built, twice:

- **By path.** A file whose name looks like a secret — `.env*`, `*.pem`,
  `*.key`, `id_rsa*`, anything with `credentials` in the path, `*.p12` — is
  never read at all. Its diff is not fetched, so nothing to leak ever exists.
- **By value.** Every `KEY=` / `TOKEN=` / `SECRET=` / `PASSWORD=` assignment
  left in the text has its value replaced with `[redacted]`. That is the case
  the path rule cannot catch: a credential pasted into `config.ts`.

It over-redacts on purpose. A number that comes out as `[redacted]` is a
question the reviewer can ask; the opposite mistake is a key in somebody's
transcript. The message says what was withheld, and the whole thing is capped at
200 KB — the pane is told when it is only seeing part of the change.

The dialog closes as soon as you pick a pane. A busy agent may take minutes to
be free, and a modal parked over the app for the duration would be holding your
keyboard for a message it has already accepted; every outcome arrives as a
toast.

## The editor

Monaco over a file tree of the active project, themed from the same tokens as
the rest of the app. It is where a clicked file path from terminal output opens,
at the line — and it is **writable**.

- **⌘S** saves the file you are on. It works from inside the editor, which is
  the only place anyone presses it, and does nothing when there is nothing
  unsaved.
- **A tab with unsaved changes** shows a dot where its close button would be.
  Closing it asks: *Save and close*, *Discard*, or *Cancel*.
- **Save all** is in the command palette rather than on a chord — ⌘⇧S is
  already the session save, and a second meaning for ⇧ would be a coin toss.
  *Revert* and *Close the current file* are there too.

**When somebody else edits the file.** In this app that is not the rare case —
it is an agent in the pane next door. The editor re-checks the file you are
looking at whenever you come back to the window (and when you switch to a tab).
If you have nothing unsaved it simply shows you the new contents. If you do, it
asks:

- **Keep mine** leaves your version in the editor; saving it overwrites what is
  on disk.
- **Take theirs** loads the file from disk and discards what you typed.

Both answers adopt the disk version as the new baseline, so you are not asked
the same question again on the next focus.

### ⌘P — go to file

The file tree is fine for browsing and hopeless for finding. **⌘P** opens a
fuzzy search over the project's files: type part of a name or a path, **↑ / ↓**
move, **Enter** opens it in the editor, **Escape** closes the box.

The list is built by walking the project directory, skipping `.git`,
`node_modules`, `target` and `dist` — the four that are enormous, machine-written
and never what you are looking for. It is cached and rebuilt each time the box
opens, so the second ⌘P is instant and still current. With no workspace project
directory there is nothing to search, and the chord stays out of the way.

## The command palette

**⌘K** opens it from anywhere except a text field. Type a few letters of what you
want — initials work, so `nw` finds "New workspace…" and `swb` finds "Switch to
beta". **↑ / ↓** move, **Enter** runs, **Escape** or **⌘K** again closes it.

It reaches: making and switching workspaces, saving and browsing sessions, every
pane action, the right panel's modes, the git actions (commit, stage all,
unstage all, refresh, switch branch, new worktree, ask an agent to review), the
editor's (go to file, save, save all, revert, close), the board, Roc, dictation
on and off, switching between dictating and talking to Roc, zoom, every Settings
section, and every theme by name. Results are
grouped, and a row shows the chord if it has one.

Only actions that make sense right now are listed. The pane actions are absent
while RocPlan or Roc has the main area — including *Launch every pane* and *Stop
every pane*, which are the two that would act on sixteen agents you cannot see.
"Switch to *X*" never offers the workspace you are in, "Show the Inspector" is
not offered while the Inspector is on screen, and the theme you are using is not
offered again.

## Settings

The gear in the topbar, or **⌘K** and the section's name. Settings covers the
dock; the sidebar and right panel stay live, and the terminals keep running
behind it. **Escape** closes it.

- **Appearance** — ten themes with live previews, applied as you arrow through
  them. Zoom lives here too.
- **Terminal** — font size and scrollback, applied to open terminals
  immediately.
- **Agents** — the default agent type, model and permission mode for new panes.
- **Notifications** — a sound when an agent finishes a turn, a sound when one
  asks for permission, and a master mute. Sounds only: the bell's list and the
  green border on a finished pane stay put under the mute, because silencing the
  room should not cost you the signals you can only see.
- **Voice** — RocTalk's push-to-talk key, Whisper model size, input device, and
  where a finished transcript goes (the same setting the widget's Dictate /
  Talk to Roc switch writes); then **Roc**: which model does its thinking,
  whether replies are spoken, in which of the system's voices, in which manner
  and at what speaking rate (with an Audition button that reads a line in all
  three), and whether its plans are sent without asking.
- **Shortcuts** — a live table of every key the app binds. It claims to be the
  whole list, not a selection.
- **History** — saved sessions, and the panes that failed to start, with why.
- **About** — version, the repository, and "What's new" again.

### Zoom

**⌘+** and **⌘−** step the whole window's scale; **⌘0** returns to 100%. It is
persisted.

It moves the *chrome* — sidebar, headers, dialogs, the board — and deliberately
not the terminals: how much scrollback fits on screen is a different question
from how big the frame around it is, and it has its own setting under Terminal.

The zoom keys are the one exception to "chords stand down while a dialog is
open", for the reason that rule exists: they act on the window, which is never
the thing you cannot see.

## Every shortcut

Settings › Shortcuts is the authoritative list and updates itself. This is the
same thing on paper.

### Anywhere

| Key | Action |
| --- | --- |
| **⌘K** | Command palette (again to close, from inside its box too) |
| **⌘+** / **⌘=** | Zoom in |
| **⌘−** / **⌘_** | Zoom out |
| **⌘0** | Zoom back to 100% |
| **⌘T** | New workspace |
| **⌘1**–**⌘9** | Switch to the *n*th workspace |
| **⌘⇧S** | Save the active workspace as a named session |
| **⌘⇧P** | Show the RocPlan board, or go back |
| **⌘⇧M** | Show RocMind, or go back |
| **⌘⇧R** | Show Roc, or go back |
| **⌘⇧K** | Open the Git panel with the commit box focused |
| **⌘P** | Go to file — fuzzy, over the project |
| **⌘S** | Save the file the editor is on |
| push-to-talk | Hold to dictate (`⌥Space` by default) |

Everything above except the zoom keys stands down inside a text field and while a
dialog or Settings is open. Four exceptions to the text-field half: **⌘S** and
**⌘P** fire from inside the code editor, which is a text field and is the only
place either is worth pressing; and **⌘⇧M** and **⌘⇧R** fire from inside
RocMind's search box and Roc's own fields, because otherwise the way out of
either view would be unreachable from the box you are typing in.

### The terminals view

| Key | Action |
| --- | --- |
| **⌘D** | Split the focused pane to the right |
| **⌘⇧D** | Split the focused pane downwards |
| **⌘N** | New pane beside the focused one |
| **⌘W** | Close the focused pane (asks while it is running) |

These four also stand down while RocPlan, RocMind or Roc has the main area — the panes are
still running back there, and a chord that closed one you cannot see would be
acting behind your back.

### Inside a surface

| Where | Key | Action |
| --- | --- | --- |
| Command palette | **↑ / ↓** | Move (the list wraps) |
| Command palette | **Enter** | Run the highlighted command |
| Command palette | **Esc** | Close, running nothing |
| Go to file (⌘P) | **↑ / ↓** | Move down the matches |
| Go to file (⌘P) | **Enter** | Open the highlighted file |
| Go to file (⌘P) | **Esc** | Close the box |
| Git's commit box | **⌘↵** | Commit what is staged (Enter is a newline) |
| Git's branch box | **Enter** | Check out the first match, or create it |
| Roc's command bar | **Enter** | Send to everyone it is aimed at |
| Roc's command bar | **⌘Enter**, **⇧Enter** | Newline instead of sending |
| Roc's sessions rail | **↑ / ↓** | Move, and watch that session |
| Roc's sessions rail | **Space** | Tick the session as a target |
| Roc's live terminal | **Enter** | Send what is typed to that one pane |
| The sidebar | **↑ / ↓** | Move between workspaces, switching as you go |
| The sidebar | **Enter**, **Space** | Switch to the focused workspace |
| The board | **← / →** | Move the focused card between columns |
| The board | **Enter**, **Space** | Open the focused card |
| Settings | **↑ ↓ ← →** | Move through a group of choices, applying |
| Notifications | **Enter** | Open that notification's terminal |
| Browser | **Enter** | Go to the typed address |
| Any rename | **Enter** / **Esc** | Commit / cancel |
| Any dialog | **Tab** | Next control — focus cannot leave the dialog |
| Any dialog | **Esc** | Close it |
| A confirmation | **Enter** | Answer yes |
| A confirmation | **Esc** | Answer no — the same as Cancel |

A confirmation opens with focus on **Cancel**, so the destructive answer is
never the one a stray Return lands on; **Enter** still means yes, from wherever
the focus is inside the dialog. A Return you were already *holding* when the
question appeared does not count as an answer — the app throws away the
autorepeat, because a key that went down before the question existed cannot
have been a reply to it.

## Where your data lives

| What | Where |
| --- | --- |
| Workspaces, panes and terminals | `workspace.dat` in the app data directory |
| Settings | `settings.dat`, alongside it |
| Named sessions | `~/.rocspace/sessions/<name>.json` |
| Agent status events | `~/.rocspace/agent-events.jsonl` |
| Whisper models | the app data directory |
| A project's board | `<project>/.rocspace/plan.json` |

Settings are kept in a separate file from the workspace snapshot on purpose: they
are not per-project, and they should survive anything that happens to your
layout.

Nothing is sent anywhere. The only network access RocSpace makes on its own is
downloading a Whisper model, from Hugging Face, when you first use dictation.

## When something goes wrong

**A pane did not start.** Settings › History lists startup failures with the
reason. If the agent's CLI is not installed the pane shows the shell's own error
and goes to the error status — relaunch it from the pane header, or from the
topbar's Launch all, once the CLI is there. Plain Shell panes get an ordinary
interactive shell, so they are the way back to a prompt in that directory.

**The board says it could not save.** RocPlan holds a lock while it writes and
re-reads before it decides; if a write fails the banner offers to retry it. The
file on disk is never half-written — writes go to a temporary file and are
renamed into place.

**The Git panel says nothing, or says something red.** It draws the failure in
place rather than raising it as a notification, because the commonest cause is a
workspace whose project directory is not a repository — and a toast per refresh
for a thing you already know is a stream of noise. A *command* you pressed a
button for is the other way round: it toasts, carrying git's own message.

**A file you saved came back different.** An agent in a pane was editing it too.
The editor asks — *Keep mine* / *Take theirs* — when it notices a file changed
on disk while you had unsaved work in it, and it only notices when you come back
to the window, so a long stretch in a terminal can hide the question until you
return.

**Dictation does nothing.** Check Settings › Voice: RocTalk has to be on, the
model has to be downloaded, and if your push-to-talk key is a bare key rather
than a chord it is only heard while RocSpace is the front window.

**Roc says it cannot find Claude Code.** Its brain runs the `claude` CLI, looked
for in three places in turn: the PATH RocSpace itself was given, then your own
shell started the way Terminal starts it (so `~/.zshrc` counts, which is where
the Claude Code installer and nvm/fnm/volta put theirs), then the places
`claude` installs itself — `~/.local/bin`, Homebrew's prefixes. A version
installed only inside a project, or for a different account, will not be found.
Install Claude Code (`npm install -g @anthropic-ai/claude-code`) and press Ask
Roc again — nothing needs restarting — or set `ROCSPACE_CLAUDE_BIN` to the
binary's full path. Roc's other half — hearing you, aiming a message, sending
it — works without any of that.

**Roc thought about it and said nothing useful.** The stage keeps the failure in
place: a turn that timed out, an answer that was not a plan, or the CLI's own
complaint (an expired login, a model you cannot reach). Your sentence is still
there — a turn that went nowhere does not eat what you said.

**A theme looks wrong in the window frame.** The native window follows the active
theme's mode and background. If you started the app before the setting loaded you
may see one frame of the default; it corrects itself.

**Something else.** The renderer logs to the DevTools console, and a render error
inside the shell is caught and shown with its stack rather than leaving a black
window.
