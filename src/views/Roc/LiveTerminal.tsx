/** Roc's live terminal — what the agent you are watching has on its screen.
 *
 *  ── Why this is a mirror and not the terminal itself ─────────────────────
 *
 *  The plan offered two ways to put a pane's terminal on this surface: move the
 *  live xterm here and back on exit, or read it. This is the read, and the
 *  reason is the dock's portal invariant.
 *
 *  A pane's card is portaled into a host element that lives for the pane's whole
 *  life, and `PaneSlot` ADOPTS that host imperatively in a layout effect keyed
 *  on `[hostFor, terminalId]` — see `PaneTree`. Nothing re-runs that effect when
 *  the host is moved by somebody else. So a Roc view that appended the host into
 *  its own box would take it out of the dock permanently: the slot's cleanup
 *  checks `host.parentNode === slot` and correctly declines to act, and no later
 *  commit puts it back. The pane would come back blank, and `paneStability`'s
 *  "the same DOM node, still connected" invariant would be false for a reason
 *  its tests do not even look for, because moving a host is not a reshape.
 *
 *  Calling `term.open()` on an element here is the same bug wearing a different
 *  hat: xterm re-parents its own element into whatever you open it on, which
 *  empties the dock's host, and it rebuilds the renderer — dropping the WebGL
 *  addon `useXterm` attaches and detaches by host connectivity.
 *
 *  Reading cannot break any of that. `buffer.active` is the live instance's own
 *  buffer, updated by the writes `outputQueue` already makes every frame,
 *  including the ALTERNATE buffer — so a TUI (vim, htop, the agent CLIs) shows
 *  up here even though none of it is in the output ring the store keeps.
 *  Nothing in this file touches a DOM node the dock owns.
 *
 *  What it costs: colour. The mirror is text, and the escape sequences that
 *  painted it are consumed by xterm before this reads anything. Fidelity of
 *  attributes is a per-cell read (`IBufferLine.getCell`) and is left for later —
 *  the layout, the cursor line and the words are what "what is it doing right
 *  now" needs.
 *
 *  ── The input line ───────────────────────────────────────────────────────
 *
 *  A real write to the PTY, framed exactly the way Phase 3 frames one:
 *  `toBracketedPaste` sanitizes (ESC and C0 stripped, `\r` folded into `\n`,
 *  paste markers neutralized) and wraps in bracketed paste with the trailing
 *  carriage return that submits it. Imported from `lib/agentDispatch` rather
 *  than reimplemented — that module is where every dispatch in the app gets
 *  its framing.
 *
 *  This is one pane, typed at directly — not a dispatch. It does not wait for
 *  readiness and it does not queue, because the user is looking at the screen
 *  they are typing into, which is the whole point of the panel. It does refuse
 *  a pane whose process has exited, for the reason `rocplanDispatch` does: Rust
 *  keeps an exited session, so the write would succeed into a dead descriptor
 *  and nothing would ever say so.
 *
 *  ── Typing to a pane with no screen here ─────────────────────────────────
 *
 *  A workspace switch is no longer one of these. The dock hosts every
 *  workspace's cards, not the active one's (see `PaneCardHost`), so a
 *  background agent keeps its xterm, keeps parsing the output written into it,
 *  and is mirrored here exactly like a pane on the dock that is up.
 *
 *  What is left is a pane whose card has not mounted YET — a session hydrated
 *  from the boot snapshot in the frames before the dock renders, or one that
 *  belongs to no workspace's tree. It is transient and the registry announces
 *  the end of it, so the mirror lights up on its own.
 *
 *  Meanwhile the box stays enabled, because refusing it would be the bigger
 *  lie: nothing killed anything — only `closeWorkspace` calls `terminalKill` —
 *  and the write lands in the PTY whether or not anything here is showing its
 *  screen. What it does instead is say the write is BLIND in the placeholder,
 *  in the empty state above it, and in a toast on the way out, which is the
 *  only acknowledgement a blind send can have. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CornerDownLeft, SquareTerminal } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { commands } from "@/lib/bindings";
import { isComposingKey } from "@/lib/dom";
import { notifyTerminalUserInput } from "@/lib/ptyBridge";
import { toBracketedPaste } from "@/lib/agentDispatch";
import { getTerminal, onTerminalRegistryChange } from "@/lib/terminalRegistry";
import { cn } from "@/lib/utils";
import { useTerminalById, useToastsStore, useWorkspacesStore } from "@/stores";
import { STATUS_DOT, STATUS_LABEL } from "@/views/RocDock/PaneHeader";

/** The visible screen of a live terminal, as lines of text.
 *
 *  `viewportY` rather than the top of the scrollback: this is a mirror of what
 *  is ON the screen, and a user who has scrolled the pane up has scrolled what
 *  this shows. Trailing blank rows are dropped so a mostly-empty shell does not
 *  render as a screenful of nothing. */
export function readViewport(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buffer.getLine(buffer.viewportY + i);
    rows.push(line ? line.translateToString(true) : "");
  }
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

export function LiveTerminal({ terminalId }: { terminalId: string | null }) {
  const terminal = useTerminalById(terminalId);
  const [draft, setDraft] = useState("");
  const pushToast = useToastsStore((s) => s.push);
  const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);

  // Which live instance we are mirroring, subscribed rather than polled.
  //
  // The answer starts as "none" for any session whose card is not mounted —
  // one the dock is still building, whichever workspace it belongs to — and
  // becomes an instance the moment it is, which is a change no store and no
  // render of ours can see. The registry's own subscription is the signal; the
  // snapshot is the instance itself, so it is referentially stable for as long
  // as the pane lives.
  const term = useSyncExternalStore(
    onTerminalRegistryChange,
    useCallback(
      () => (terminalId ? (getTerminal(terminalId) ?? null) : null),
      [terminalId],
    ),
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !terminal) return;
    // Rust keeps an exited session in its map, so the write would succeed into
    // a dead descriptor and say nothing. Ask before writing, not after.
    if (terminal.status === "complete" || terminal.status === "error") {
      pushToast({
        message: `${terminal.name}'s agent has exited — restart it first`,
        tone: "warn",
      });
      return;
    }
    setDraft("");
    commands
      .terminalWrite(terminal.id, toBracketedPaste(text))
      .then(() => {
        // The pane has been typed into. The idle watchdog and the notifications
        // bridge both gate on this flag; a pane written to without it would
        // neither warn about a permission prompt nor ping when it finished.
        notifyTerminalUserInput(terminal.id);
        // Nothing above this box will move: the pane has no xterm mounted here
        // to mirror. Say the message went, because otherwise the only evidence
        // is the box emptying itself.
        if (!term) {
          pushToast({
            message: `Sent to ${terminal.name} — its screen is not mirrored here, so nothing will show up above`,
          });
        }
      })
      .catch((err) => {
        console.warn("[roc] live terminal write failed:", err);
        pushToast({
          message: `Could not send that to ${terminal.name}`,
          tone: "warn",
        });
      });
  }, [draft, terminal, term, pushToast]);

  if (!terminalId || !terminal) {
    return (
      <Shell>
        <Empty
          icon={<SquareTerminal className="h-5 w-5" />}
          message={
            terminalId
              ? "That session is gone."
              : "Pick a session on the left to watch it work."
          }
        />
      </Shell>
    );
  }

  return (
    <Shell
      header={
        <>
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              STATUS_DOT[terminal.status],
            )}
          />
          <span className="truncate text-xs font-medium text-fg-primary">
            {terminal.name}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-fg-muted">
            {STATUS_LABEL[terminal.status]}
          </span>
        </>
      }
    >
      {term ? (
        // Keyed on the session so switching gets a fresh screen rather than
        // one that opens on the previous agent's last frame.
        <Mirror key={terminalId} term={term} />
      ) : (
        <Empty
          icon={<SquareTerminal className="h-5 w-5" />}
          message={
            // A pane the dock is still building, on either dock — being in
            // another workspace is no longer a reason to have no screen here,
            // because a background workspace's cards are mounted and mirrored
            // like any other (see `PaneCardHost`). It will light up on its own
            // the moment the registry has it.
            //
            // Neither sentence may suggest the agent stopped. It has not: only
            // `closeWorkspace` kills a PTY, and what is missing is the MIRROR.
            terminal.workspaceId === activeWorkspaceId
              ? `${terminal.name}'s pane has not mounted yet — its screen will appear here as soon as it does.`
              : `${terminal.name} is in another workspace and its pane has not mounted yet. It is still running — its screen will appear here as soon as the pane is up. You can type to it below meanwhile, blind.`
          }
          action={
            terminal.workspaceId && terminal.workspaceId !== activeWorkspaceId
              ? {
                  label: "Switch to that workspace",
                  run: () => setActiveWorkspace(terminal.workspaceId),
                }
              : null
          }
        />
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-2 py-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // The Enter that accepts an IME candidate is not the Enter that
            // sends — see `isComposingKey`. Without this, composing 「テスト」
            // writes the half-finished draft straight into the PTY.
            if (isComposingKey(e)) return;
            e.preventDefault();
            send();
          }}
          placeholder={
            term
              ? `Type to ${terminal.name}…`
              : `Type to ${terminal.name} — blind, no screen here`
          }
          aria-label={
            term
              ? `Send to ${terminal.name}`
              : `Send to ${terminal.name} (blind — its screen is not mirrored here)`
          }
          className="min-w-0 flex-1 rounded-input border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active"
        />
        <button
          type="button"
          onClick={send}
          disabled={draft.trim() === ""}
          title="Send"
          aria-label="Send"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </Shell>
  );
}

/** The screen itself.
 *
 *  Its own component so it can be keyed on the session, and so its state exists
 *  only while there is a terminal to mirror — the alternative was an effect that
 *  cleared it, which is a cascading render for something nobody can see. */
function Mirror({ term }: { term: Terminal }) {
  // Read once during the first render rather than from an effect: a mirror that
  // starts empty and fills in on the next frame flashes "nothing here" over an
  // agent mid-sentence.
  const [rows, setRows] = useState<string[]>(() => readViewport(term));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Driven by `onWriteParsed` rather than `onRender`: the dock is `hidden`
  // while this view is up, and a terminal nobody is painting does not render —
  // but it does still parse everything written to it, which is where the buffer
  // this reads comes from. Coalesced into one animation frame, so a pane
  // streaming a build costs one read per frame rather than one per chunk.
  useEffect(() => {
    // `pending` rather than the frame id as the guard. The id is only assigned
    // once `requestAnimationFrame` RETURNS, and the callback can already have
    // run by then — which is what happens under a test that flushes frames
    // synchronously, and left the guard permanently armed so the mirror froze
    // after its first read.
    let pending = false;
    let frame = 0;
    const read = () => {
      pending = false;
      setRows(readViewport(term));
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(read);
    };
    // Catch up on whatever landed between the first render and this commit.
    schedule();
    const disposables = [
      term.onWriteParsed(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
    ];
    return () => {
      if (pending) cancelAnimationFrame(frame);
      for (const d of disposables) d.dispose();
    };
  }, [term]);

  // Follow the bottom, the way a terminal does.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <div
      ref={scrollRef}
      data-roc-live-mirror
      className="allow-select min-h-0 flex-1 overflow-auto bg-surface-0 px-3 py-2 font-mono text-[11px] leading-[1.35] text-fg-primary"
    >
      {rows.length === 0 ? (
        <p className="italic text-fg-muted">Nothing on screen yet.</p>
      ) : (
        rows.map((line, i) => (
          // Index keys: these are screen ROWS, and row 4 is row 4 whatever is
          // printed on it. Keying by content would rebuild the whole block
          // every time one character changed.
          <div key={i} className="whitespace-pre">
            {line === "" ? " " : line}
          </div>
        ))
      )}
    </div>
  );
}

function Shell({
  header,
  children,
}: {
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="Live terminal"
      className="flex h-full min-h-0 flex-col bg-surface-1"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        {header ?? (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Live terminal
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

function Empty({
  icon,
  message,
  action,
}: {
  icon: React.ReactNode;
  message: string;
  action?: { label: string; run: () => void } | null;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center text-fg-muted">
        {icon}
        <p className="text-xs italic">{message}</p>
        {action ? (
          <button
            type="button"
            onClick={action.run}
            className="rounded-md bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors hover:bg-surface-3"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
