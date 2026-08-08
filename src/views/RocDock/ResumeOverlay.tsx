/** The cold Claude pane's question: pick the conversation back up, or start
 *  over?
 *
 *  It appears on a pane that has a Claude conversation waiting and no process
 *  running — a snapshot pane that was NOT mid-flight at quit (so boot did not
 *  respawn it), or a restored saved session. Neither of those is a pane the app
 *  should start behind the user's back: a boot that resumed every Claude pane
 *  it had ever seen would fire off a dozen agents nobody asked for, and a saved
 *  session's uuid can be weeks old, by which time `--resume` fails and takes
 *  the pane down with it at launch.
 *
 *  So the choice is deferred to the person who knows which they wanted, and it
 *  is deferred *visibly* — an idle pane with no explanation is one the user has
 *  to guess about.
 *
 *  What it must NOT do is offer a conversation that is gone. A session the user
 *  never sent a turn in leaves no transcript at all, so "pick it up where it
 *  left off" was regularly an offer to do something impossible — and taking it
 *  killed the pane, because `claude --resume` at a conversation that does not
 *  exist prints "No conversation found with session ID" and quits. So the offer
 *  is CHECKED before it is made (`claudeConversationExists`), and a pane whose
 *  conversation is gone is told so and offered the only thing left.
 *
 *  The check is cosmetic honesty, not the safety net: `terminal_spawn` starts a
 *  fresh conversation rather than fail whichever button is pressed. Which is
 *  why nothing here waits for the answer before drawing — a half-second of a
 *  button that would have worked anyway is not worth a spinner on every cold
 *  pane. */

import { useEffect, useState } from "react";
import { History, Play } from "lucide-react";
import { commands } from "@/lib/bindings";
import { spawnTerminal } from "@/lib/spawn";
import { cn } from "@/lib/utils";
import { useResumableClaudeSession, useTerminalById } from "@/stores";

export function ResumeOverlay({ terminalId }: { terminalId: string }) {
  const resumable = useResumableClaudeSession(terminalId);
  const terminal = useTerminalById(terminalId);
  // Local, because it describes this dialog rather than the pane: the buttons
  // go the instant one is pressed, but the *offer* is only spent once a
  // process actually exists.
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  // `null` until the answer lands, and the offer is drawn in full meanwhile —
  // see the note above. `true` on any failure to ask: a pane whose conversation
  // could not be looked up must keep the offer it would have had.
  const [stillThere, setStillThere] = useState<boolean | null>(null);

  useEffect(() => {
    if (!resumable) return;
    let current = true;
    void commands
      .claudeConversationExists(resumable)
      .then((exists) => {
        if (current) setStillThere(exists);
      })
      .catch(() => {
        if (current) setStillThere(true);
      });
    // The pane can be offered a different conversation (a restore lands while
    // this one is still in flight), and an answer about the old uuid must not
    // be applied to the new one.
    return () => {
      current = false;
    };
  }, [resumable]);

  // A pid is the pane answering for itself: something is running here, whatever
  // started it, so the offer is stale.
  if (!resumable || !terminal || terminal.pid !== null) return null;

  const start = (resume: string | null) => {
    // The parked uuid is NOT cleared here. On a restored saved session it is
    // the only copy of the conversation there is; on a hydrated pane it is
    // what makes the uuid still on the session an OFFER rather than a live
    // process. Clearing it before the spawn lands takes the question away on
    // exactly the spawns that fail — `claude` not on PATH, a transcript the
    // CLI has since dropped, a directory that is gone.
    // `spawnTerminal` clears it after the IPC resolves, which is the earliest
    // moment the pane is really in a conversation.
    //
    // The buttons still go immediately: one press is one PTY, and a button
    // that stays put under the cursor while the IPC is in flight invites a
    // second press. They come back if the spawn fails, with the offer intact.
    setStarting(true);
    setFailed(false);
    void spawnTerminal(terminal, { resumeClaudeSession: resume }).then((ok) => {
      if (ok) return;
      setStarting(false);
      setFailed(true);
    });
  };

  return (
    <div
      // Over the terminal, not beside it: there is nothing running underneath
      // to interact with, and the pane's own scrollback is the context for the
      // question.
      className={cn(
        "absolute inset-0 z-10 grid place-items-center",
        "bg-surface-0/85 backdrop-blur-[2px]",
      )}
    >
      <div className="flex max-w-[280px] flex-col items-center gap-3 px-4 text-center">
        <p className="text-xs font-medium text-fg-primary">
          {stillThere === false
            ? "This pane's conversation is no longer available."
            : "This pane has a Claude conversation waiting."}
        </p>
        {starting ? (
          <p className="text-[11px] leading-relaxed text-fg-muted">Starting…</p>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-fg-muted">
              {stillThere === false
                ? // Named, because "gone" without a reason reads as data loss.
                  // A session nobody prompted never became a conversation, and
                  // that is by far the most common way to arrive here.
                  "Claude Code has no transcript for it — a session that was never prompted leaves nothing to resume. Starting fresh keeps the pane."
                : "Pick it up where it left off, or start a new one. Starting fresh keeps the pane and forgets the conversation."}
            </p>
            {failed ? (
              // The pane did not come up, and the question is still open — so
              // is the conversation. The reason is in Settings › History,
              // where every spawn failure this run is recorded.
              <p className="text-[11px] leading-relaxed text-warning">
                That did not start. The conversation is still here — Settings ›
                History has the reason.
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              {stillThere === false ? null : (
                <button
                  type="button"
                  onClick={() => start(resumable)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-input bg-accent px-3 py-1.5",
                    "text-xs font-medium text-accent-fg hover:opacity-90",
                  )}
                >
                  <History className="h-3.5 w-3.5" />
                  Resume conversation
                </button>
              )}
              <button
                type="button"
                onClick={() => start(null)}
                className={cn(
                  "flex items-center gap-1.5 rounded-input px-3 py-1.5 text-xs",
                  // The only thing left to do becomes the primary action,
                  // rather than sitting there greyed beside a gap.
                  stillThere === false
                    ? "bg-accent font-medium text-accent-fg hover:opacity-90"
                    : "bg-surface-2 text-fg-primary hover:bg-surface-3",
                )}
              >
                <Play className="h-3.5 w-3.5" />
                Start fresh
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
