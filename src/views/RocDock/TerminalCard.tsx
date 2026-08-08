import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useXterm } from "@/views/RocDock/useXterm";
import { PaneHeader } from "@/views/RocDock/PaneHeader";
import { ResumeOverlay } from "@/views/RocDock/ResumeOverlay";
import {
  OUTPUT_RING_BUFFER_CAP,
  useActiveWorkspacePaneTree,
  useActiveWorkspaceTerminalCount,
  useFocusedTerminalId,
  useHighlightedTerminalId,
  useMaximizedTerminalId,
  useTerminalById,
  useTerminalHasUserInput,
  useTerminalRuntimeStore,
  useTerminalTurnFinished,
  useTerminalsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { accentVar } from "@/lib/accentColors";
import { replayableOutput } from "@/lib/outputReplay";

export function TerminalCard({ terminalId }: { terminalId: string }) {
  const terminal = useTerminalById(terminalId);
  const focusedId = useFocusedTerminalId();
  const highlightedId = useHighlightedTerminalId();
  const maximizedId = useMaximizedTerminalId();
  const focusTerminal = useUIStore((s) => s.focusTerminal);
  const clearTurnFinished = useTerminalRuntimeStore((s) => s.clearTurnFinished);

  const { containerRef, handleRef } = useXterm(terminalId);
  const hasUserInput = useTerminalHasUserInput(terminalId);
  const turnFinished = useTerminalTurnFinished(terminalId);

  // The stripe down the card's left edge is the WORKSPACE's accent — what used
  // to say which group a pane belonged to now says which project it is in,
  // which is the distinction that survived Phase 2. A `var(--rs-*)` reference,
  // so a theme switch re-colours it without a render.
  //
  // Its OWN workspace's, not the active one's. The dock hosts every workspace's
  // cards now (see `PaneCardHost`), so "the workspace on screen" and "the
  // workspace this pane belongs to" are no longer the same question — and only
  // the second one has an answer that stays true while the card is off screen.
  //
  // Subscribed to the accent alone, not the workspace: sixteen cards holding a
  // reference to the workspace object would all re-render every time the store
  // rebuilds it, which is every focus change.
  const workspaceId = terminal?.workspaceId ?? null;
  const accent = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.accent ?? null,
  );
  const accentColor = accent ? accentVar(accent) : null;

  // Replay this session's ring buffer into a freshly opened xterm.
  //
  // Live output does NOT come through here: `outputQueue` writes it straight to
  // the xterm instance on an animation frame (see `terminalRegistry`), so the
  // bytes reach the pane without passing through React. The card is not off
  // React's render path — the same flush appends to the store's ring buffer and
  // this component subscribes to that — but it re-renders once per flush rather
  // than once per PTY chunk, and it writes nothing when it does.
  //
  // This effect covers the one case the queue cannot — an xterm younger than
  // the output it should be showing. That is now a genuinely rare case: a pane
  // keeps its terminal across every reshape AND every workspace switch (see
  // `PaneTree`), so what is left is a session hydrated from the boot snapshot,
  // and bytes that arrived in the frames before the terminal opened.
  //
  // What may be written is `outputReplay`'s to decide, not this component's.
  // Raw PTY bytes are screen operations, and the ones that address a ROW are
  // only meaningful from a point where the screen state is known — replaying
  // the whole ring regardless is what put two renders of the same Claude line
  // in the same cells. Most of what a pane emits addresses nothing but the line
  // it is on and replays exactly as it rendered, so most rings still go through
  // whole; that module draws the line, and only a stream it cannot place gets
  // shown as a transcript.
  //
  // The ring's length against its cap is the one input that module cannot get
  // for itself: it says whether these bytes still begin where the process did.
  //
  // It runs after `useXterm`'s mount effect (hook order within this component)
  // and in the same commit, so no frame can slip between opening the terminal
  // and replaying into it.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.clear();
    const buffered = useTerminalsStore.getState().byId[terminalId]?.output;
    if (!buffered || buffered.length === 0) return;
    const replay = replayableOutput(buffered, {
      fromStreamStart: buffered.length < OUTPUT_RING_BUFFER_CAP,
    });
    if (replay !== "") handle.write(replay);
  }, [terminalId, handleRef]);

  // Force a refit whenever the layout context changes (a split, a close, a
  // maximize toggle). ResizeObserver normally catches this, but rapid
  // back-to-back DOM moves — splitting a pane moves every card in that arm at
  // once — can outpace the observer and leave a stale cell grid behind, which
  // renders as visibly inconsistent pane sizes. Explicit fits across two
  // animation frames cover both the pre- and post-flow layout settling.
  //
  // This is the whole refit path now: a reshape reparents this card's host
  // element (see `PaneCardHost`) instead of remounting it, so there is no fresh
  // mount effect coming to size the new box.
  //
  // The tree is a persistent structure, so its identity changes exactly when
  // the layout does — not on the PTY-output writes the store sees constantly.
  const paneTree = useActiveWorkspacePaneTree();
  const workspaceTerminalCount = useActiveWorkspaceTerminalCount();
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      handleRef.current?.fit();
      raf2 = requestAnimationFrame(() => handleRef.current?.fit());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [paneTree, maximizedId, workspaceTerminalCount, handleRef]);

  if (!terminal) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-border bg-surface-1 text-xs text-fg-muted">
        Terminal removed
      </div>
    );
  }

  const isFocused = terminal.id === focusedId;
  const isHighlighted = terminal.id === highlightedId;
  const isMaximized = terminal.id === maximizedId;

  // Three things light a pane green, and only one of them is a status.
  //
  // `complete` (the process exited) and `awaiting_approval` (it stopped to ask)
  // are gated on user input, so a freshly spawned pane never lights up from an
  // early agent-CLI exit before anyone has typed.
  //
  // The end of a TURN is not a status: a Claude pane rests at `idle` between
  // turns, so "idle" says nothing about whether anything just happened, and
  // reading it here is what made an agent finishing a prompt produce no signal
  // at all. `turnFinished` is the bridge's answer to the question the card
  // cannot ask — did a turn end here while the user was looking somewhere
  // else — and it carries its own user-input gate (see `notificationsBridge`).
  const isReady =
    turnFinished ||
    (hasUserInput &&
      (terminal.status === "complete" ||
        terminal.status === "awaiting_approval"));

  return (
    <div
      // Identifies the card's root element to tests that need to prove a
      // reshape moved this exact DOM node rather than building a new one.
      data-terminal-id={terminal.id}
      onClick={() => {
        focusTerminal(terminal.id);
        // Clicking a pane that finished is how you answer it. Deliberately a
        // click and not focus: the pane may already BE focused when its turn
        // ends, and clearing on focus would put the border up and take it down
        // in the same frame.
        clearTurnFinished(terminal.id);
      }}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-surface-1 transition-colors",
        isFocused ? "border-border-active" : "border-border",
        isReady ? "terminal-ready-pulse" : null,
        isHighlighted ? "terminal-flash-outline" : null,
      )}
      style={{ boxShadow: paneShadow({ isFocused, accentColor, isReady }) }}
    >
      <PaneHeader
        terminal={terminal}
        isFocused={isFocused}
        isMaximized={isMaximized}
      />
      {/* The host is wrapped rather than positioned itself: `useXterm` owns
          that element's box, and the overlay needs a positioned parent that is
          not it. */}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={containerRef}
          className="terminal-host h-full w-full overflow-auto bg-surface-0"
        />
        <ResumeOverlay terminalId={terminal.id} />
      </div>
    </div>
  );
}

/** The card's whole `box-shadow`, as one expression.
 *
 *  It has to be one: a `boxShadow` in `style` replaces the property outright,
 *  so while the accent stripe lived there and the focus ring lived in a
 *  `shadow-[…]` class, the ring was dead for every pane that had a stripe —
 *  which is every pane. Composing them here is what makes the focused pane
 *  visibly focused again.
 *
 *  Every part is INSET. A pane's box is flush with its neighbour's — the gutter
 *  is the 2px separator and nothing else — and the pane clips its contents, so
 *  an outer shadow would render entirely outside the clip and be invisible.
 *
 *  Order is paint order, first on top:
 *    1. accent stripe — the left edge stays the workspace's colour even when
 *       focused
 *    2. focus ring — 1px rim on the other three edges
 *    3. ready glow — rim + vignette saying "this agent needs you", pulsing off
 *       the animated `--ready-glow` variables. */
export function paneShadow({
  isFocused,
  accentColor,
  isReady,
}: {
  isFocused: boolean;
  accentColor: string | null;
  isReady: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (accentColor) parts.push(`inset 3px 0 0 0 ${accentColor}`);
  if (isFocused) {
    parts.push(
      "inset 0 0 0 1px color-mix(in srgb, var(--rs-primary) 45%, transparent)",
    );
  }
  if (isReady) {
    parts.push(
      "inset 0 0 0 1.5px color-mix(in srgb, var(--rs-success) var(--ready-glow, 55%), transparent)",
      "inset 0 0 22px 2px color-mix(in srgb, var(--rs-success) var(--ready-glow-soft, 30%), transparent)",
    );
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}
