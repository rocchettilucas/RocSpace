/** Hand the staged diff to an agent.
 *
 *  One question — which pane — because everything else is decided by
 *  `lib/gitReview`: what is safe to send, how it is framed, and when the pane
 *  can take it. This is the picker and the promise; that module is the policy.
 *
 *  The promise is spelled out on screen rather than left in a doc comment. The
 *  diff is about to leave the machine, and a user who is one click from that
 *  deserves to read what is being withheld before they click. */

import { Bot } from "lucide-react";
import { reviewStagedDiff } from "@/lib/gitReview";
import { cn } from "@/lib/utils";
import { useActiveWorkspaceTerminals, useGitStatus } from "@/stores";
import { hasExited } from "@/lib/agentDispatch";
import { ModalShell } from "@/views/Workspaces/ModalShell";

export function GitReviewDialog({ onClose }: { onClose: () => void }) {
  const status = useGitStatus();
  const panes = useActiveWorkspaceTerminals();
  const staged = status?.staged ?? [];
  // A pane whose process is gone would take the write and drop it: Rust keeps
  // the session, so the bytes land in a dead file descriptor and the call
  // succeeds. Not offering it is better than reporting it afterwards.
  const candidates = panes.filter((p) => !hasExited(p));

  const send = (terminalId: string) => {
    // Closed first, deliberately. The dispatch waits for the pane to be free,
    // which can be minutes if it is answering a permission prompt, and a modal
    // parked over the app for the duration would be holding the keyboard
    // hostage for a message it has already accepted. Every outcome is a toast.
    onClose();
    void reviewStagedDiff(terminalId);
  };

  return (
    <ModalShell
      title="Ask an agent to review"
      onClose={onClose}
      width="w-[480px]"
    >
      {staged.length === 0 ? (
        <p className="text-xs leading-relaxed text-fg-secondary">
          Nothing is staged. Stage what you want reviewed first — a review of an
          empty diff is a message nobody can answer.
        </p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-fg-secondary">
            The staged diff ({staged.length} file
            {staged.length === 1 ? "" : "s"}) goes to the pane you pick, with a
            note asking for a review rather than an edit.
          </p>
          <p className="rounded-input border border-border bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
            Files whose paths look like credentials (
            <span className="font-mono">.env*</span>,{" "}
            <span className="font-mono">*.pem</span>,{" "}
            <span className="font-mono">*.key</span>,{" "}
            <span className="font-mono">id_rsa*</span>,{" "}
            <span className="font-mono">*credentials*</span>,{" "}
            <span className="font-mono">*.p12</span>) are never read, and any{" "}
            <span className="font-mono">KEY=</span> /{" "}
            <span className="font-mono">TOKEN=</span> /{" "}
            <span className="font-mono">SECRET=</span> /{" "}
            <span className="font-mono">PASSWORD=</span> value left in the text
            is masked. The agent is told what was withheld.
          </p>

          {candidates.length === 0 ? (
            <p className="text-xs text-fg-muted">
              No pane in this workspace has a live agent to ask.
            </p>
          ) : (
            <div className="flex max-h-64 flex-col overflow-y-auto rounded-input border border-border">
              {candidates.map((pane) => (
                <button
                  key={pane.id}
                  type="button"
                  onClick={() => send(pane.id)}
                  className={cn(
                    "flex items-center gap-2 border-b border-border px-2.5 py-2 text-left",
                    "text-xs text-fg-secondary last:border-b-0 hover:bg-surface-2 hover:text-fg-primary",
                  )}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate">{pane.name}</span>
                  <span className="shrink-0 text-[10px] text-fg-muted">
                    {pane.status.replace("_", " ")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}
