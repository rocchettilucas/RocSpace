/** New worktree — a second checkout of this repository, on its own branch, in
 *  its own directory.
 *
 *  The point of the button. A worktree shares one object store with no clone
 *  and no stashing, so "run three agents on three branches at once" stops being
 *  a sequence of `git stash` and becomes three directories — which is exactly
 *  three workspaces, which is what RocSpace already is. That is why the last
 *  step offers to open one: the worktree is only interesting once something is
 *  working in it.
 *
 *  Two questions and a toggle. Where it goes, which branch it is on, and
 *  whether that branch exists yet — git's `-b` fails rather than reusing a
 *  branch that is already checked out somewhere, which is the refusal a user
 *  wants and not one to paper over. */

import { useEffect, useState } from "react";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { commands } from "@/lib/bindings";
import { cn } from "@/lib/utils";
import {
  gitErrorMessage,
  useGitBranches,
  useGitStore,
  useToastsStore,
  useWorkspacesStore,
} from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";

/** `/code/rocspace` + `feature/x` → `/code/rocspace-feature-x`, the sibling
 *  directory a worktree conventionally lands in. A suggestion the user can
 *  overwrite, not a rule — it is only filled in while the field is untouched. */
export function suggestWorktreePath(repo: string, branch: string): string {
  const trimmed = repo.replace(/\/+$/, "");
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "";
  return `${trimmed}-${slug}`;
}

export function GitWorktreeDialog({ onClose }: { onClose: () => void }) {
  const repo = useGitStore((s) => s.repo);
  const branches = useGitBranches();
  const loadBranches = useGitStore((s) => s.loadBranches);
  const createWorkspace = useWorkspacesStore((s) => s.createWorkspace);
  const pushToast = useToastsStore((s) => s.push);

  const [branch, setBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  // Only needed for the "check out a branch that already exists" half, and the
  // dialog is cheap to open — so it is fetched on open rather than kept warm.
  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const effectivePath =
    pathTouched || repo === null
      ? path
      : suggestWorktreePath(repo, branch.trim());
  const ready =
    repo !== null &&
    branch.trim().length > 0 &&
    effectivePath.trim().length > 0 &&
    !busy;

  const choose = async () => {
    try {
      const selected = await openDirectoryDialog({
        directory: true,
        multiple: false,
        title: "Where should the worktree go?",
      });
      if (typeof selected === "string") {
        setPathTouched(true);
        setPath(selected);
      }
    } catch (err) {
      // The click has to answer for itself. Swallowed into a console line,
      // pressing the folder icon simply did nothing — and "nothing happened"
      // is the one outcome a user cannot act on.
      pushToast({
        message: `Could not open the directory picker: ${gitErrorMessage(err)}`,
        tone: "warn",
      });
    }
  };

  const create = async () => {
    if (!ready || repo === null) return;
    setBusy(true);
    try {
      await commands.gitWorktreeAdd(
        repo,
        effectivePath.trim(),
        branch.trim(),
        createBranch,
      );
      setCreated(effectivePath.trim());
    } catch (err) {
      pushToast({ message: gitErrorMessage(err), tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  if (created !== null) {
    return (
      <ModalShell title="Worktree created" onClose={onClose} width="w-[480px]">
        <p className="text-xs leading-relaxed text-fg-secondary">
          <span className="font-mono text-fg-primary">{branch.trim()}</span> is
          checked out at
        </p>
        <p className="break-all rounded-input bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-fg-primary">
          {created}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => {
              // A worktree with nothing running in it is a directory. This is
              // the step that makes it a place to work.
              createWorkspace({
                projectPath: created,
                paneCount: 1,
                agentTypes: [],
              });
              onClose();
            }}
            className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
          >
            Open as workspace
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title="New worktree"
      onClose={onClose}
      width="w-[480px]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void create()}
            className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-fg-secondary">
          Branch
        </span>
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          list={createBranch ? undefined : "git-worktree-branches"}
          placeholder={createBranch ? "feature/thing" : "an existing branch"}
          spellCheck={false}
          autoComplete="off"
          className="rounded-input border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active"
        />
        <datalist id="git-worktree-branches">
          {branches
            .filter((b) => !b.isRemote)
            .map((b) => (
              <option key={b.name} value={b.name} />
            ))}
        </datalist>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={createBranch}
          onChange={(e) => setCreateBranch(e.target.checked)}
          className="h-3 w-3 accent-accent"
        />
        <span className="text-[11px] text-fg-secondary">
          Create the branch (fails if it already exists)
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-fg-secondary">
          Directory
        </span>
        <div className="flex gap-2">
          <input
            value={effectivePath}
            onChange={(e) => {
              setPathTouched(true);
              setPath(e.target.value);
            }}
            placeholder="/absolute/path/to/the/worktree"
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-2.5 py-1.5",
              "font-mono text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active",
            )}
          />
          <button
            type="button"
            onClick={() => void choose()}
            title="Choose a directory"
            aria-label="Choose a directory"
            className="grid h-[30px] w-9 shrink-0 place-items-center rounded-input border border-border text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-[10px] leading-relaxed text-fg-muted">
          Suggested beside the repository until you change it. Git refuses a
          directory that already has something in it.
        </span>
      </label>
    </ModalShell>
  );
}
