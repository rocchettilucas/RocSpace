/** The Git panel: review what changed, stage it, commit it, without leaving
 *  RocSpace.
 *
 *  The fourth right-panel mode, and the one with the shortest leash to the
 *  filesystem: everything on screen is a fact about a working tree that an
 *  agent in a pane, or the user's own shell, is changing at the same time. So
 *  it re-reads on every mutation, on mount, and on window focus — the moment
 *  the user comes back from a terminal is exactly the moment the picture is
 *  most likely to be stale.
 *
 *  Scoped to the ACTIVE workspace's project directory. Not the focused pane's
 *  cwd: a pane can be `cd`'d anywhere, and a panel that followed it would swap
 *  repositories under a half-typed commit message. The workspace's project is
 *  the thing the user chose. */

import { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  FolderGit2,
  GitBranch as GitBranchIcon,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { GitFileEntry, GitFileStatus, GitStatus } from "@/lib/bindings";
import { cn } from "@/lib/utils";
import {
  hasStagedChanges,
  unstagePathsFor,
  useActiveWorkspace,
  useGitDialog,
  useGitSelection,
  useGitStatus,
  useGitStore,
  useUIStore,
  watchGitRepo,
} from "@/stores";
import { GitBranchDialog } from "@/views/RightPanel/GitBranchDialog";
import { GitDiffPane } from "@/views/RightPanel/GitDiffPane";
import { GitReviewDialog } from "@/views/RightPanel/GitReviewDialog";
import { GitWorktreeDialog } from "@/views/RightPanel/GitWorktreeDialog";

/** The letter in the gutter, and what it means. One character because the
 *  panel is a column and a filename needs every pixel; the word is on the
 *  `title` for anyone who wants it. */
const STATUS_GLYPH: Record<GitFileStatus, { letter: string; tone: string }> = {
  modified: { letter: "M", tone: "text-warning" },
  added: { letter: "A", tone: "text-success" },
  deleted: { letter: "D", tone: "text-error" },
  renamed: { letter: "R", tone: "text-info" },
  untracked: { letter: "U", tone: "text-fg-muted" },
  conflicted: { letter: "C", tone: "text-error" },
};

export function GitView() {
  const workspace = useActiveWorkspace();
  const repo = workspace?.projectPath ?? null;
  const setRepo = useGitStore((s) => s.setRepo);
  const refresh = useGitStore((s) => s.refresh);
  const status = useGitStatus();
  const error = useGitStore((s) => s.error);
  const loading = useGitStore((s) => s.loading);
  const dialog = useGitDialog();
  const openDialog = useUIStore((s) => s.openGitDialog);
  const closeDialog = useUIStore((s) => s.closeGitDialog);

  useEffect(() => {
    setRepo(repo);
  }, [repo, setRepo]);

  // A dialog flag that outlives its renderer is a dead application: nothing is
  // drawn, the scrim is gone, and `blockingModalOpen` keeps every chord in the
  // app — ⌘T included — standing down for a modal nobody can close. The dialogs
  // are rendered HERE, so this is the one place that can promise it never
  // happens, whatever unmounts the panel.
  useEffect(() => () => closeDialog(), [closeDialog]);

  // Mount, and every return to the window. A `git` invocation per focus is one
  // process for a panel the user is looking at — cheap next to showing them a
  // file list their agent invalidated two minutes ago.
  useEffect(() => {
    if (!repo) return;
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    // Visibility as well as focus, because the watcher below declines to read
    // a hidden window: this is what collects whatever it declined. They
    // overlap — un-minimising usually focuses too — and a duplicate `git
    // status` is cheaper than the class of stale panel that gets through.
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [repo, refresh]);

  // And the signal the other two cannot give: an agent staging or committing
  // beside this panel never touches the window's focus.
  useEffect(() => {
    if (!repo) return;
    return watchGitRepo(repo);
  }, [repo]);

  if (!repo) {
    return (
      <EmptyPanel>
        {workspace
          ? "This workspace has no project directory, so there is no repository to show. Set one when you create it."
          : "Open a workspace to review its repository."}
      </EmptyPanel>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <GitHeader
        onRefresh={() => void refresh()}
        loading={loading}
        onBranch={() => openDialog("branch")}
        onWorktree={() => openDialog("worktree")}
        onReview={() => openDialog("review")}
      />

      {error !== null ? (
        <EmptyPanel tone="error">{error}</EmptyPanel>
      ) : status === null ? (
        <EmptyPanel>{loading ? "Reading the repository…" : ""}</EmptyPanel>
      ) : (
        <>
          <FileLists status={status} />
          <DiffRegion />
          <CommitBox canCommit={hasStagedChanges(status)} />
        </>
      )}

      {dialog === "branch" ? <GitBranchDialog onClose={closeDialog} /> : null}
      {dialog === "worktree" ? (
        <GitWorktreeDialog onClose={closeDialog} />
      ) : null}
      {dialog === "review" ? <GitReviewDialog onClose={closeDialog} /> : null}
    </div>
  );
}

function EmptyPanel({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "grid flex-1 place-items-center whitespace-pre-wrap px-6 text-center text-xs",
        tone === "error" ? "text-status-error" : "text-fg-muted",
      )}
    >
      {children}
    </div>
  );
}

// Header --------------------------------------------------------------------

function GitHeader({
  onRefresh,
  loading,
  onBranch,
  onWorktree,
  onReview,
}: {
  onRefresh: () => void;
  loading: boolean;
  onBranch: () => void;
  onWorktree: () => void;
  onReview: () => void;
}) {
  const status = useGitStatus();
  const branch = status?.branch ?? null;

  return (
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        type="button"
        onClick={onBranch}
        title="Switch or create a branch"
        className="flex min-w-0 items-center gap-1.5 rounded-input px-1.5 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
      >
        <GitBranchIcon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{branch ?? "—"}</span>
      </button>

      {/* State, not verbs. There is no `git_push` and no `git_pull` behind this
          panel, and naming the one action a counter cannot take is a promise
          the panel has no way to keep. */}
      {status && status.ahead > 0 ? (
        <span
          title={`${status.ahead} commit(s) ahead of upstream`}
          className="flex shrink-0 items-center text-[10px] text-fg-muted"
        >
          <ArrowUp className="h-3 w-3" />
          {status.ahead}
        </span>
      ) : null}
      {status && status.behind > 0 ? (
        <span
          title={`${status.behind} commit(s) behind upstream`}
          className="flex shrink-0 items-center text-[10px] text-fg-muted"
        >
          <ArrowDown className="h-3 w-3" />
          {status.behind}
        </span>
      ) : null}

      <div className="flex-1" />

      <IconButton
        label="Ask an agent to review the staged diff"
        onClick={onReview}
      >
        <Bot className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="New worktree…" onClick={onWorktree}>
        <FolderGit2 className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="Refresh" onClick={onRefresh}>
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
      </IconButton>
    </header>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-input text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
    >
      {children}
    </button>
  );
}

// File lists ----------------------------------------------------------------

function FileLists({ status }: { status: GitStatus }) {
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const changed = [...status.unstaged, ...status.untracked];

  if (status.staged.length === 0 && changed.length === 0) {
    return (
      <div className="grid shrink-0 basis-24 place-items-center px-6 text-center text-xs text-fg-muted">
        Nothing to commit — the working tree is clean.
      </div>
    );
  }

  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto">
      <FileSection
        title="Staged"
        entries={status.staged}
        staged
        bulkLabel="Unstage all"
        onBulk={() => void unstage(status.staged.flatMap(unstagePathsFor))}
        onRowAction={(entry) => void unstage(unstagePathsFor(entry))}
        rowActionLabel="Unstage"
        rowActionIcon={<Minus className="h-3 w-3" />}
      />
      <FileSection
        title="Changes"
        entries={changed}
        staged={false}
        bulkLabel="Stage all"
        onBulk={() => void stage(changed.map((e) => e.path))}
        onRowAction={(entry) => void stage([entry.path])}
        rowActionLabel="Stage"
        rowActionIcon={<Plus className="h-3 w-3" />}
      />
    </div>
  );
}

function FileSection({
  title,
  entries,
  staged,
  bulkLabel,
  onBulk,
  onRowAction,
  rowActionLabel,
  rowActionIcon,
}: {
  title: string;
  entries: GitFileEntry[];
  staged: boolean;
  bulkLabel: string;
  onBulk: () => void;
  onRowAction: (entry: GitFileEntry) => void;
  rowActionLabel: string;
  rowActionIcon: React.ReactNode;
}) {
  const selection = useGitSelection();
  const select = useGitStore((s) => s.select);
  if (entries.length === 0) return null;

  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-1 px-2 py-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {title}
        </h3>
        <span className="text-[10px] text-fg-muted">{entries.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onBulk}
          className="rounded-input px-1.5 py-0.5 text-[10px] text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
        >
          {bulkLabel}
        </button>
      </div>
      {entries.map((entry) => {
        const glyph = STATUS_GLYPH[entry.status];
        const isSelected =
          selection?.path === entry.path && selection.staged === staged;
        return (
          <div
            key={`${staged ? "s" : "u"}:${entry.path}`}
            className={cn(
              "group flex items-center gap-1 px-2",
              isSelected ? "bg-accent-soft" : "hover:bg-surface-2",
            )}
          >
            <button
              type="button"
              onClick={() => void select(entry.path, staged)}
              aria-pressed={isSelected}
              // An `R` row draws the new name and nothing else, and its
              // per-file diff has no rename header — git pairs a rename across
              // a whole diff, not within one pathspec. Without this the old
              // name is nowhere on screen.
              title={
                entry.originPath
                  ? `${entry.path} — ${entry.status} from ${entry.originPath}`
                  : `${entry.path} — ${entry.status}`
              }
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
            >
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[10px] font-bold",
                  glyph.tone,
                )}
              >
                {glyph.letter}
              </span>
              {/* Right-to-left so a long path truncates at the FRONT: the
                  filename is what identifies a row, and
                  `src/views/RightPanel/Gi…` identifies nothing. */}
              <span
                dir="rtl"
                className="min-w-0 flex-1 truncate text-left text-[11px] text-fg-secondary"
              >
                {entry.path}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onRowAction(entry)}
              title={`${rowActionLabel} ${entry.path}`}
              aria-label={`${rowActionLabel} ${entry.path}`}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-input text-fg-muted opacity-0 hover:bg-surface-3 hover:text-fg-primary focus-visible:opacity-100 group-hover:opacity-100"
            >
              {rowActionIcon}
            </button>
          </div>
        );
      })}
    </section>
  );
}

// Diff ----------------------------------------------------------------------

function DiffRegion() {
  const selection = useGitSelection();
  const diff = useGitStore((s) => s.diff);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const diffError = useGitStore((s) => s.diffError);

  return (
    <div className="min-h-0 flex-1 border-t border-border">
      {selection === null ? (
        <div className="grid h-full place-items-center px-6 text-center text-xs text-fg-muted">
          Pick a file to see what changed.
        </div>
      ) : diffError !== null ? (
        <div className="grid h-full place-items-center whitespace-pre-wrap px-6 text-center text-xs text-status-error">
          {diffError}
        </div>
      ) : diffLoading || diff === null ? (
        <div className="grid h-full place-items-center text-xs text-fg-muted">
          Reading the diff…
        </div>
      ) : (
        <GitDiffPane path={selection.path} diff={diff} />
      )}
    </div>
  );
}

// Commit --------------------------------------------------------------------

function CommitBox({ canCommit }: { canCommit: boolean }) {
  const message = useGitStore((s) => s.message);
  const setMessage = useGitStore((s) => s.setMessage);
  const commit = useGitStore((s) => s.commit);
  const committing = useGitStore((s) => s.committing);
  const focusNonce = useGitStore((s) => s.commitFocusNonce);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  // ⌘⇧K asks for this box wherever the user was. The chord cannot focus a
  // field that may not be mounted when it fires, so it bumps a counter and the
  // box — which by then IS mounted, because the same chord opened the panel —
  // answers it here.
  useEffect(() => {
    if (focusNonce === 0) return;
    boxRef.current?.focus();
  }, [focusNonce]);

  const ready = canCommit && message.trim().length > 0 && !committing;

  return (
    <div className="shrink-0 border-t border-border p-2">
      <textarea
        ref={boxRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          // ⌘Enter commits from inside the box. Enter alone is a newline: a
          // commit message has a subject line and a body, and a box that sent
          // on Enter could never hold one.
          if (e.key !== "Enter" || !e.metaKey) return;
          e.preventDefault();
          if (ready) void commit();
        }}
        rows={2}
        placeholder="Commit message  (⌘↵ to commit)"
        spellCheck={false}
        aria-label="Commit message"
        className="w-full resize-none rounded-input border border-border bg-surface-2 px-2 py-1.5 font-sans text-[11px] leading-relaxed text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active"
      />
      <button
        type="button"
        disabled={!ready}
        onClick={() => void commit()}
        className="mt-1.5 w-full rounded-input bg-accent px-2 py-1.5 text-[11px] font-medium text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {committing ? "Committing…" : "Commit"}
      </button>
    </div>
  );
}
