/** The 28 px strip across the top of a pane.
 *
 *  Everything the user needs to know about a pane without reading its output —
 *  is the agent working, what is this pane called, where is it, what branch is
 *  it on — plus every action that reshapes it. */

import {
  GitBranch,
  Maximize2,
  Minimize2,
  RotateCcw,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AGENT_BADGE } from "@/lib/agentLabels";
import { LIMITS } from "@/lib/limits";
import { spawnTerminal } from "@/lib/spawn";
import { cn } from "@/lib/utils";
import { useCanAddPane, useTerminalsStore, useUIStore } from "@/stores";
import { useGitBranch } from "@/hooks/useGitBranch";
import {
  closeTerminalPane,
  splitTerminal,
  uniquePaneName,
} from "@/views/RocDock/paneActions";
import type { TerminalSession, TerminalStatus } from "@/lib/bindings";

/** Exported since Phase 4: Roc's sessions rail lists the same panes this header
 *  sits on, and a pane that is amber here and green there is a pane the user
 *  cannot trust either reading of. One map, both surfaces. */
export const STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  error: "Error",
  complete: "Complete",
  paused: "Paused",
};

/** The dot's fill. Deliberately keyed on status rather than on which CLI the
 *  pane runs: the teardown's demo tinted its dot per agent because the dot was
 *  the only place agent identity appeared, whereas here the badge beside it
 *  already says "Claude". What the badge cannot say is whether the agent is
 *  waiting on you, and that is the whole reason to glance at a pane. */
export const STATUS_DOT: Record<TerminalStatus, string> = {
  idle: "bg-status-idle",
  running: "bg-status-running",
  awaiting_approval: "bg-status-waiting",
  error: "bg-status-error",
  complete: "bg-status-complete",
  paused: "bg-status-paused",
};

/** Header fill: the surface, pulled most of the way back to the background so
 *  the chrome reads as a rail rather than a second panel. */
const HEADER_BG =
  "color-mix(in srgb, var(--rs-surface) 55%, var(--rs-background))";
const HEADER_BG_ACTIVE = `color-mix(in srgb, var(--rs-primary) 6%, ${HEADER_BG})`;
const HEADER_BORDER_ACTIVE =
  "color-mix(in srgb, var(--rs-primary) 26%, transparent)";

/* -- what the header gives up first, and when ------------------------------
 *
 * A 4-across dock puts panes at ~250px, and the header wants more than that:
 * the action row alone is a fixed 128px. Something has to go, and which
 * something is the whole question. It used to be decided by nothing but the
 * class list — everything except the name and the directory was `shrink-0`,
 * so the NAME was the first thing squeezed to an ellipsis and the Close
 * button was the last thing standing, clipped by the header's own
 * `overflow-hidden`. Exactly backwards: the name is what the user calls the
 * pane, and it is the one thing the pane's own body cannot tell them.
 *
 * So the order of sacrifice is explicit, cheapest first: branch chip, then
 * directory, then agent badge. The name and the actions never go. The chip
 * also truncates on the way down (a branch name is long and its first
 * characters are the informative ones); the badge does not, because "OPENC…"
 * is worth nothing — it either fits or it leaves.
 *
 * Thresholds are derived rather than eyeballed, so they follow the parts they
 * are about: each is "the width at which this piece stops fitting beside a
 * name that is still readable". They are compared against the header's CONTENT
 * box, which is what `ResizeObserver` reports and which already has the
 * header's own padding taken out — so no term below accounts for it. */

/** The action row: five 24px buttons with 2px gaps, spent before anything the
 *  header *says* gets a pixel. */
const CHROME_WIDTH = 5 * 24 + 4 * 2;
/** Status dot and the 6px gap after it. Never dropped: it is 6 pixels and it
 *  is the only thing here that changes on its own. */
const DOT_WIDTH = 6 + 6;
/** The narrowest a pane name is still a name and not an ellipsis — about
 *  seven characters of 11px medium. */
const NAME_FLOOR = 48;
/** Widest each optional part gets, including the 6px gap in front of it. */
const BADGE_WIDTH = 44 + 6;
const CWD_WIDTH = 60 + 6;
const CHIP_WIDTH = 70 + 6;

const SHOW_BADGE_ABOVE = CHROME_WIDTH + DOT_WIDTH + NAME_FLOOR + BADGE_WIDTH;
const SHOW_CWD_ABOVE = SHOW_BADGE_ABOVE + CWD_WIDTH;
const SHOW_CHIP_ABOVE = SHOW_CWD_ABOVE + CHIP_WIDTH;

/** The header's own width, for the ladder above.
 *
 *  `null` until the first observation, and `null` reads as "wide enough for
 *  everything": a first paint that hides three things and then puts them back
 *  a frame later is worse than one frame of overflow. In a browser the first
 *  callback arrives with the real width immediately, so that state does not
 *  survive to be seen.
 *
 *  Cannot loop: the header's width comes from the pane above it, never from
 *  its own content, so dropping a child cannot change what is being measured. */
function useHeaderWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    // Absent in jsdom, and in a plain browser this is the only thing here that
    // is not universally available.
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      // The content box — padding already removed, which is the box the
      // thresholds above are written against.
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

export function PaneHeader({
  terminal,
  isFocused,
  isMaximized,
}: {
  terminal: TerminalSession;
  isFocused: boolean;
  isMaximized: boolean;
}) {
  const branch = useGitBranch(terminal.projectPath);
  // Subscribed rather than read imperatively: the split buttons' disabled
  // state has to follow the workspace's session count on its own rather than
  // depend on something else re-rendering this header at the right moment.
  const canSplit = useCanAddPane(terminal.workspaceId);
  const toggleMaximize = useUIStore((s) => s.toggleMaximizeTerminal);

  /** The split buttons' tooltip: the chord normally, the reason they are dead
   *  when the workspace is full. The *name* stays the action either way — see
   *  `HeaderButton`. */
  const splitTitle = (chord: string) =>
    canSplit
      ? chord
      : `Workspace cap reached (${LIMITS.terminalsPerWorkspace})`;

  const headerRef = useRef<HTMLElement>(null);
  const width = useHeaderWidth(headerRef);
  /** Unmeasured reads as roomy — see `useHeaderWidth`. */
  const roomFor = (threshold: number) => width === null || width >= threshold;

  return (
    <header
      ref={headerRef}
      className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-b pl-2.5 pr-1"
      style={{
        background: isFocused ? HEADER_BG_ACTIVE : HEADER_BG,
        borderBottomColor: isFocused
          ? HEADER_BORDER_ACTIVE
          : "var(--rs-border)",
      }}
    >
      <span
        role="img"
        aria-label={`Status: ${STATUS_LABEL[terminal.status]}`}
        title={STATUS_LABEL[terminal.status]}
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          STATUS_DOT[terminal.status],
          // The one status the user is expected to wait through.
          terminal.status === "running" && "motion-safe:animate-pulse",
        )}
      />

      <PaneTitle terminal={terminal} />

      {roomFor(SHOW_BADGE_ABOVE) ? (
        // Not truncatable on purpose: four to eight characters, of which the
        // first few do not distinguish "Claude" from "Codex" any better than
        // nothing does.
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-fg-muted">
          {AGENT_BADGE[terminal.agentConfig.type]}
        </span>
      ) : null}

      {terminal.projectPath && roomFor(SHOW_CWD_ABOVE) ? (
        <span
          className="min-w-0 shrink-[8] truncate text-[10px] text-fg-muted"
          title={terminal.projectPath}
        >
          {directoryTail(terminal.projectPath)}
        </span>
      ) : null}

      {branch !== null && roomFor(SHOW_CHIP_ABOVE) ? (
        <BranchChip branch={branch} />
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <HeaderButton
          label="Split right"
          title={splitTitle("Split right (⌘D)")}
          icon={<SquareSplitHorizontal className="h-3 w-3" />}
          onClick={() => splitTerminal(terminal.id, "row")}
          disabled={!canSplit}
        />
        <HeaderButton
          label="Split down"
          title={splitTitle("Split down (⌘⇧D)")}
          icon={<SquareSplitVertical className="h-3 w-3" />}
          onClick={() => splitTerminal(terminal.id, "column")}
          disabled={!canSplit}
        />
        <HeaderButton
          label={isMaximized ? "Exit focus mode" : "Focus this terminal"}
          icon={
            isMaximized ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )
          }
          onClick={() => toggleMaximize(terminal.id)}
        />
        <HeaderButton
          label="Restart"
          icon={<RotateCcw className="h-3 w-3" />}
          // Re-reads the session's agent config, which is what makes an
          // Inspector edit (model, permissions, prompt) take effect — and the
          // only way to bring a pane whose CLI exited back to life.
          onClick={() => void spawnTerminal(terminal)}
        />
        <HeaderButton
          label="Close"
          title="Close (⌘W)"
          icon={<X className="h-3 w-3" />}
          onClick={() => void closeTerminalPane(terminal.id)}
          danger
        />
      </div>
    </header>
  );
}

/** The pane's name, renameable in place.
 *
 *  Double-click is the affordance the rest of the world uses for renaming a
 *  tab, and Enter on the focused title does the same thing — a rename reachable
 *  only by pointer is a rename half the app cannot do. */
function PaneTitle({ terminal }: { terminal: TerminalSession }) {
  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const [draft, setDraft] = useState<string | null>(null);
  // Enter and Escape both close the editor, and closing it also blurs the
  // input — and blur is what commits. This is "this editing session is already
  // decided", so whichever of the two arrives second does nothing.
  //
  // Reset when the editor OPENS, never when a blur is observed. Clearing it in
  // `onBlur` was the bug: the input unmounts on the Enter and Escape paths, so
  // no blur ever arrives to do the clearing, and the flag stayed true into the
  // next editing session — where it swallowed the click-away commit.
  const settled = useRef(false);

  const open = () => {
    settled.current = false;
    setDraft(terminal.name);
  };

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft?.trim() ?? "";
    setDraft(null);
    // An empty name would leave the pane with nothing to be addressed by, so
    // it reads as a cancel rather than as a valid new name.
    if (commit && next && next !== terminal.name) {
      // Disambiguated rather than taken verbatim: two panes in one workspace
      // answering to the same name is an ambiguity everywhere the user
      // addresses a pane by it. See `uniquePaneName` for why it suffixes
      // instead of refusing.
      renameTerminal(
        terminal.id,
        uniquePaneName(terminal.workspaceId, next, terminal.id),
      );
    }
  };

  if (draft === null) {
    return (
      <button
        type="button"
        // Without this the control is announced as just the pane's name, which
        // says what it holds and nothing about it being a button or what
        // pressing it does. The name stays inside the label, so the accessible
        // name still contains the visible one.
        aria-label={`Rename pane (currently ${terminal.name})`}
        title={`${terminal.name} — double-click to rename`}
        onDoubleClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "F2") {
            e.preventDefault();
            open();
          }
        }}
        // Shrink weight 1 against the directory's and the chip's 8: the name is
        // the last thing in the header to give up a pixel, because it is the
        // one thing here the pane's own body cannot tell the user.
        className="min-w-0 shrink truncate text-left text-[11px] font-medium text-fg-primary"
      >
        {terminal.name}
      </button>
    );
  }

  return (
    <input
      aria-label="Pane name"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      // A click in the field must not reach the card, whose click handler moves
      // focus to the terminal.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The pane chords are bound on the document in the capture phase, so
        // this cannot be what stops ⌘W closing the pane mid-rename —
        // `isTypingTarget` does that. This stops the keystroke reaching
        // anything bound closer, xterm included.
        e.stopPropagation();
        if (e.key === "Enter") {
          finish(true);
        } else if (e.key === "Escape") {
          finish(false);
        }
      }}
      // Clicking away is a commit — the same call every rename-in-place field
      // makes. `finish` itself ignores this when a key already decided, so a
      // blur that a browser does fire on the way out cannot undo an Escape.
      onBlur={() => finish(true)}
      className="min-w-0 shrink rounded-sm border border-border-active bg-surface-0 px-1 text-[11px] font-medium text-fg-primary outline-none"
    />
  );
}

/** 18 px pill naming the branch the pane's directory is on. Absent, not empty,
 *  when the directory is not a repository. */
function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      // Named the way the status dot is, and for the same reason: the icon that
      // makes this a *branch* is decorative, so without a label the chip is
      // announced as the bare word "main" — which could be anything.
      role="img"
      aria-label={`On branch ${branch}`}
      title={`On branch ${branch}`}
      // Gives up width before it gives up entirely: a branch name's leading
      // characters are its informative ones, so "revamp/phase-1…" still says
      // something. `shrink-[8]` is what makes it, and the directory, hand over
      // pixels ahead of the pane's name.
      className="flex h-[18px] min-w-0 shrink-[8] items-center gap-1 rounded-full bg-surface-3 pl-1.5 pr-2 text-[10px] text-fg-secondary"
    >
      <GitBranch className="h-2.5 w-2.5 shrink-0 text-accent" aria-hidden />
      <span className="max-w-[14ch] truncate">{branch}</span>
    </span>
  );
}

/** An icon button in the action row.
 *
 *  `label` is the accessible name and says only what the button DOES; `title`
 *  is the tooltip and is free to carry the chord and any current reason the
 *  button is dead. Splitting them is not cosmetic: the two split buttons used
 *  to be named by their tooltip, so at the workspace's pane cap both of them
 *  announced "Workspace cap reached (16)" — two identically named buttons, and
 *  neither name saying which direction it splits. A control's name has to be
 *  stable, because it is how the user refers to it. */
function HeaderButton({
  label,
  title,
  icon,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  title?: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        // The card focuses its terminal on click; pressing its close button is
        // not a request to focus the thing being closed.
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid h-6 w-6 place-items-center rounded-[7px] text-fg-muted transition-[background-color,color,transform]",
        disabled
          ? "cursor-not-allowed opacity-40"
          : danger
            ? "hover:-translate-y-px hover:bg-error/15 hover:text-error active:scale-90"
            : "hover:-translate-y-px hover:bg-surface-3 hover:text-fg-primary active:scale-90",
      )}
    >
      {icon}
    </button>
  );
}

/** Last segment of a path, in either separator. The header has room for the
 *  directory the pane is in, not the road to it. */
function directoryTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
