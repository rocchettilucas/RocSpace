/** Switch to a branch, or start one.
 *
 *  One dialog for both, like the RocPlan card editor: the list is the answer
 *  most of the time, and "a branch that does not exist yet" is the same
 *  question with the name typed instead of picked.
 *
 *  A remote-tracking row is offered under its SHORT name. Checking out
 *  `origin/topic` literally would detach HEAD — git says so and suggests
 *  `--detach` or `-c` — which is never what clicking a branch means. Handing
 *  git `topic` instead lets its own DWIM create the local branch tracking that
 *  remote, which is the thing the click was asking for. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch as GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitBranches, useGitStore } from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";

/** `origin/topic` → `topic`; a local name is already short. */
export function localNameFor(name: string, isRemote: boolean): string {
  if (!isRemote) return name;
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

export function GitBranchDialog({ onClose }: { onClose: () => void }) {
  const branches = useGitBranches();
  const loadBranches = useGitStore((s) => s.loadBranches);
  const checkout = useGitStore((s) => s.checkout);
  const loading = useGitStore((s) => s.branchesLoading);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(needle));
  }, [branches, filter]);

  // Offer to create only when what was typed is not already a branch — under
  // either spelling, so typing `topic` while `origin/topic` exists offers the
  // checkout that tracks it rather than a second branch of the same name.
  const typed = filter.trim();
  const canCreate =
    typed.length > 0 &&
    !branches.some((b) => localNameFor(b.name, b.isRemote) === typed);

  const run = async (branch: string, create: boolean) => {
    setBusy(true);
    const ok = await checkout(branch, create);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <ModalShell
      title="Switch branch"
      onClose={onClose}
      initialFocusRef={filterRef}
      width="w-[440px]"
    >
      <input
        ref={filterRef}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        // The dialog opens with this field focused, and `ModalShell` deliberately
        // leaves Escape alone while a text field has the keyboard (there, it
        // means "abandon what I typed"). In a dialog that IS one field the two
        // meanings coincide, so it handles its own — the same arrangement the
        // Save session prompt makes.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Enter" || busy) return;
          e.preventDefault();
          if (canCreate) {
            void run(typed, true);
            return;
          }
          const first = matches.find((b) => !b.isCurrent);
          if (first) void run(localNameFor(first.name, first.isRemote), false);
        }}
        placeholder="Filter, or type a new branch name"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active"
      />

      {canCreate ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(typed, true)}
          className="flex items-center gap-2 rounded-input border border-accent/40 bg-accent-soft px-2.5 py-2 text-left text-xs text-fg-primary hover:border-accent disabled:opacity-50"
        >
          <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 truncate">
            Create branch <span className="font-mono">{typed}</span> from here
          </span>
        </button>
      ) : null}

      <div className="flex max-h-72 flex-col overflow-y-auto rounded-input border border-border">
        {loading && branches.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-fg-muted">Reading branches…</p>
        ) : matches.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-fg-muted">
            {branches.length === 0
              ? "This repository has no branches yet — the first commit makes one."
              : "No branch matches that."}
          </p>
        ) : (
          matches.map((branch) => (
            <button
              key={`${branch.isRemote ? "r" : "l"}:${branch.name}`}
              type="button"
              disabled={busy || branch.isCurrent}
              onClick={() =>
                void run(localNameFor(branch.name, branch.isRemote), false)
              }
              className={cn(
                "flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-left text-xs last:border-b-0",
                branch.isCurrent
                  ? "text-fg-primary"
                  : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
                busy && "opacity-50",
              )}
            >
              {branch.isCurrent ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
              ) : (
                <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">
                {branch.name}
              </span>
              {branch.isRemote ? (
                <span className="shrink-0 rounded-input bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
                  remote
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </ModalShell>
  );
}
