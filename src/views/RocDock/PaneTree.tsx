import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Group,
  Panel,
  Separator,
  useGroupCallbackRef,
} from "react-resizable-panels";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { setPaneAttached } from "@/lib/paneAttachment";
import {
  MAX_PANE_RATIO,
  MIN_PANE_RATIO,
  hasLeaf,
  leafIds,
  type PaneNode,
  type SplitDirection,
} from "@/lib/paneTree";
import {
  useActiveWorkspace,
  useActiveWorkspacePaneTree,
  useMaximizedTerminalId,
  useWorkspacesStore,
} from "@/stores";
import { TerminalCard } from "@/views/RocDock/TerminalCard";

/** Every pane in the app that has a place in some workspace's tree.
 *
 *  Not the active workspace's — every workspace's. A card is the only thing
 *  that owns an xterm, so the set of hosted cards is the set of live terminals,
 *  and narrowing it to the workspace currently on screen made a switch dispose
 *  sixteen terminals and build sixteen more. What the replacements could then
 *  show is the session's ring buffer, replayed: raw PTY bytes from an agent CLI
 *  that addresses the cursor and redraws in place, written into a grid they
 *  were never painted against. They composite into fragments of a dozen
 *  historical frames — the reported symptom, two renders of the same line in
 *  the same cells.
 *
 *  There is nothing to replay if nothing was torn down, so the switch simply
 *  stops being an event: the panes of the workspace being left keep their
 *  terminals, unadopted by any slot, exactly as a maximized pane's hidden
 *  siblings already do (see `PaneCardHost` and `lib/paneAttachment`).
 *
 *  Shallow-compared, so the identity only moves when the SET does — the
 *  workspaces array is rebuilt by every rename, focus change and committed
 *  divider drag, and none of those are a change of pane. */
function useHostedTerminalIds(): readonly string[] {
  return useWorkspacesStore(
    useShallow((s) =>
      s.workspaces.flatMap((w) => (w.paneTree ? leafIds(w.paneTree) : [])),
    ),
  );
}

/** Renders the active workspace's pane tree as nested resizable groups.
 *
 *  Shape comes from the store (`workspace.paneTree`); sizing is delegated to
 *  `react-resizable-panels` and committed back on drag end. The store stays the
 *  authority — see `SplitPane` for how a reshape re-imposes it.
 *
 *  The cards themselves are deliberately NOT rendered inside that nested tree:
 *  see `PaneCardHost`. A pane's xterm is a live PTY view that cannot be rebuilt
 *  from state, so it must outlive every reshape of the layout around it — and
 *  every switch to another workspace's layout, which is why the host is fed
 *  `useHostedTerminalIds` rather than this tree's leaves.
 *
 *  For the same reason the empty states are rendered INSIDE the host rather
 *  than in place of it: a workspace with no panes is still a workspace the user
 *  can switch through, and returning early here would take every card in the
 *  app down on the way past. */
export function PaneTree() {
  const workspace = useActiveWorkspace();
  const tree = useActiveWorkspacePaneTree();
  const maximizedId = useMaximizedTerminalId();
  const hostedIds = useHostedTerminalIds();

  // Maximize is a view over the tree, not an edit of it: render the one leaf
  // full-bleed and leave the split state untouched underneath, so popping back
  // out restores the exact layout. The hidden panes keep their terminals — the
  // card list is driven by what exists, not by what is currently on screen.
  const maximized =
    tree !== null && maximizedId !== null && hasLeaf(tree, maximizedId)
      ? maximizedId
      : null;

  return (
    <PaneCardHost terminalIds={hostedIds}>
      {!workspace ? (
        <EmptyState message="No active workspace" />
      ) : !tree ? (
        <EmptyState message="No terminals in this workspace yet — press ⌘D to split one in." />
      ) : (
        /* One padded box for both modes, so the dock's inset cannot differ
           between them — an absolutely positioned child would cover the
           padding, which is what used to make the terminal jump on a maximize
           toggle. Whatever goes inside stays in normal flow. */
        <div className="h-full min-h-0 min-w-0 bg-surface-0 p-1.5">
          {maximized !== null ? (
            <PaneSlot
              terminalId={maximized}
              className="h-full min-h-0 min-w-0"
            />
          ) : (
            <div className="relative h-full min-h-0 min-w-0">
              <PaneNodeView node={tree} path="" workspaceId={workspace.id} />
            </div>
          )}
        </div>
      )}
    </PaneCardHost>
  );
}

// Stable leaf hosting ------------------------------------------------------

/** Resolves a terminal's permanent host element. */
type HostLookup = (terminalId: string) => HTMLElement;

const PaneHostContext = createContext<HostLookup | null>(null);

/** Holds every pane's card in a flat, stable, id-keyed list and portals each
 *  one into whatever slot the layout currently has for it — if the layout has
 *  one at all.
 *
 *  Why this exists: rendering a card at its position in the nested tree makes
 *  its React subtree a function of the tree's *shape*. A node that changes kind
 *  (leaf ⇄ split) is a different element type at that position, so React
 *  unmounts everything under it — and closing one pane of `row(a, row(b, c))`
 *  does exactly that to two panes that were only ever bystanders. The cost is
 *  not a re-render: `useXterm` disposes the Terminal on unmount, and the
 *  replacement can only replay the 2000-line output ring. Anything an
 *  alt-screen TUI painted (vim, htop, the agent CLIs) is not in that ring at
 *  all, so the pane comes back wrong.
 *
 *  Keeping the cards here makes their tree a function of the *set* of live
 *  terminals instead, which neither a reshape nor a workspace switch changes.
 *  A card whose pane is nowhere on screen — a maximized pane's siblings, every
 *  pane of every background workspace — is simply one no slot has adopted; it
 *  keeps its terminal, gives up its GPU context (see the attachment publish
 *  below), and is still there when the layout asks for it again.
 *
 *  What that costs, measured, and it is the number to argue with before
 *  putting a cap here: a real xterm instance is 0.21 MiB idle and 1.95 MiB
 *  holding a full scrollback of 120-column lines. FULL means 5000 lines, not
 *  2000 — `settings.terminal.scrollback` ships at 5000 (`stores/settings`), and
 *  a hidden pane fills its own from live output, which `outputQueue` writes to
 *  every registered terminal whether or not a slot has adopted it. The store's
 *  2000-line ring is a separate, smaller retention for replay and does not
 *  bound this. So three background workspaces of sixteen panes each — 48
 *  instances that used to be disposed on a switch — are about 94 MiB with every
 *  one of them full, against a floor of 10 MiB idle.
 *
 *  No cap even so: they hold no GPU context, xterm pauses the renderer for a
 *  screen element that is not intersecting, and the alternative is disposing
 *  terminals whose contents cannot be rebuilt — which is the bug this whole
 *  arrangement exists to fix. Two constraints shape the mechanics:
 *   - `createPortal` remounts its children whenever the container node changes,
 *     so each terminal gets one host element for its whole life;
 *   - that host therefore cannot be rendered by the slot, which does remount —
 *     so `PaneSlot` adopts it imperatively instead. */
function PaneCardHost({
  terminalIds,
  children,
}: {
  terminalIds: readonly string[];
  children: React.ReactNode;
}) {
  // The cache of host elements, held in state rather than a ref on purpose:
  // `hostFor` is called both from render (to target the portals) and from a
  // slot's layout effect (to adopt one), and neither side may be made to run
  // first. Because it only ever memoizes — same id, same element, forever — it
  // is safe to consult from either, which is what keeps the two halves of this
  // component free of an ordering contract.
  const [hosts] = useState<Map<string, HTMLElement>>(() => new Map());

  const hostFor = useCallback<HostLookup>(
    (terminalId) => {
      let host = hosts.get(terminalId);
      if (!host) {
        host = document.createElement("div");
        // Styled inline because this element is built outside React and
        // Tailwind only emits the utilities it can find in the source. It fills
        // its slot in normal flow, so the slot's padding stays live.
        host.style.height = "100%";
        host.style.minHeight = "0";
        host.style.minWidth = "0";
        hosts.set(terminalId, host);
      }
      return host;
    },
    [hosts],
  );

  // Forget hosts whose terminal has left every tree — a closed pane, or a
  // closed workspace's panes. Their card has already unmounted (it is gone from
  // the list below, which is the one place a card is ever legitimately torn
  // down), so the element is dead weight — and holding it would pin whatever
  // detached slot it last hung in.
  useEffect(() => {
    const live = new Set(terminalIds);
    for (const [id, host] of hosts) {
      if (!live.has(id)) {
        host.remove();
        hosts.delete(id);
      }
    }
  }, [hosts, terminalIds]);

  // Tell each card whether it is on screen.
  //
  // Nothing else can: a card holds no state that changes when the layout stops
  // showing it, because the layout does not render it — it borrows its host
  // (see `PaneSlot`). A maximize leaves fifteen cards mounted and detached,
  // holding fifteen WebGL contexts on canvases nobody is looking at, and a
  // background workspace leaves all sixteen of its own.
  //
  // Deliberately no dependency array. The publish is a diff, so re-running it
  // is free, and every way a host's attachment can change is a commit this
  // component is part of: the slots are its children. Passive, so it runs after
  // the slots' layout effects have finished moving hosts around — a reshape
  // detaches and re-adopts within one commit and settles as a non-event.
  useEffect(() => {
    for (const [id, host] of hosts) setPaneAttached(id, host.isConnected);
  });

  return (
    <PaneHostContext.Provider value={hostFor}>
      {children}
      {terminalIds.map((id) =>
        createPortal(<TerminalCard terminalId={id} />, hostFor(id), id),
      )}
    </PaneHostContext.Provider>
  );
}

/** The box a pane occupies in the current layout. Owns no card of its own — it
 *  adopts the terminal's permanent host element on mount and hands it back on
 *  unmount, so a reshape moves a DOM node instead of rebuilding a terminal. */
function PaneSlot({
  terminalId,
  className,
}: {
  terminalId: string;
  className: string;
}) {
  const hostFor = useContext(PaneHostContext);
  const slotRef = useRef<HTMLDivElement | null>(null);

  // Layout, not passive: the host has to be in place before the browser paints
  // the new arrangement, and before `useXterm`'s (passive) mount effect calls
  // `term.open`, which measures the element.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !hostFor) return;
    const host = hostFor(terminalId);
    slot.appendChild(host);
    return () => {
      // Hand the host back rather than let a slot React is about to drop take
      // the live card down with it. React runs every layout cleanup in a commit
      // before any layout effect, so the slot that inherits this pane re-adopts
      // the host in that same commit — nothing paints in between.
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [hostFor, terminalId]);

  return (
    <div ref={slotRef} data-pane-slot={terminalId} className={className} />
  );
}

/** One node, filling whatever box its parent gives it. */
function PaneNodeView({
  node,
  path,
  workspaceId,
}: {
  node: PaneNode;
  path: string;
  workspaceId: string;
}) {
  if (node.kind === "leaf") {
    // No padding: the gutter between panes is the 2px separator and nothing
    // else. Insetting the leaf as well put 2px on each side of it, so the gap
    // the user saw was 6px.
    return (
      <PaneSlot terminalId={node.terminalId} className="absolute inset-0" />
    );
  }
  return <SplitPane node={node} path={path} workspaceId={workspaceId} />;
}

function SplitPane({
  node,
  path,
  workspaceId,
}: {
  node: Extract<PaneNode, { kind: "split" }>;
  path: string;
  workspaceId: string;
}) {
  const setPaneRatio = useWorkspacesStore((s) => s.setPaneRatio);
  const [group, setGroup] = useGroupCallbackRef();

  // Panel ids are the tree paths of the two arms, which makes them unique
  // within their group by construction and stable while the shape holds.
  const firstId = `${path}f`;
  const secondId = `${path}s`;

  // Re-impose the store's ratio whenever it disagrees with what the group is
  // actually showing.
  //
  // A group instance survives reshapes: closing the left pane of
  // `row(a, row(b, c))` promotes the inner split into the root's position, and
  // the root `Group` keeps rendering with the layout it held for the *old*
  // node — `defaultSize` is a mount-time value and never gets consulted again.
  // Without this the panes would silently render at a ratio the store does not
  // hold. Guarded on a real difference, so a drag (which commits the value we
  // are already showing) does not bounce back through here.
  useEffect(() => {
    if (!group) return;
    const layout = group.getLayout();
    const first = layout[firstId];
    const second = layout[secondId];
    if (first === undefined || second === undefined) return;
    const total = first + second;
    if (total <= 0) return;
    if (Math.abs(first / total - node.ratio) < 0.005) return;
    group.setLayout({
      [firstId]: node.ratio * 100,
      [secondId]: (1 - node.ratio) * 100,
    });
  }, [group, node.ratio, firstId, secondId]);

  return (
    <Group
      id={`pane-group-${path || "root"}`}
      orientation={node.direction === "row" ? "horizontal" : "vertical"}
      groupRef={setGroup}
      // The stored ratio, as a mount-time layout. `Panel.defaultSize` alone is
      // not enough: it only wins when the group has no layout of its own, and
      // the group always derives one.
      defaultLayout={{
        [firstId]: node.ratio * 100,
        [secondId]: (1 - node.ratio) * 100,
      }}
      className="absolute inset-0"
      onLayoutChanged={(layout) => {
        const first = layout[firstId];
        const second = layout[secondId];
        if (first === undefined || second === undefined) return;
        const total = first + second;
        if (total <= 0) return;
        // Drag end only — `onLayoutChange` (no d) fires per pointer move and
        // would put a store write, and an autosave, on every frame.
        setPaneRatio(workspaceId, path, first / total);
      }}
    >
      <PaneArm id={firstId} size={node.ratio}>
        <PaneNodeView
          node={node.first}
          path={firstId}
          workspaceId={workspaceId}
        />
      </PaneArm>
      <PaneSeparator direction={node.direction} />
      <PaneArm id={secondId} size={1 - node.ratio}>
        <PaneNodeView
          node={node.second}
          path={secondId}
          workspaceId={workspaceId}
        />
      </PaneArm>
    </Group>
  );
}

function PaneArm({
  id,
  size,
  children,
}: {
  id: string;
  size: number;
  children: React.ReactNode;
}) {
  return (
    <Panel
      id={id}
      defaultSize={`${size * 100}%`}
      minSize={`${MIN_PANE_RATIO * 100}%`}
      maxSize={`${MAX_PANE_RATIO * 100}%`}
      className="relative min-h-0 min-w-0"
      // `relative` positions the pane contents; the library's own `overflow:
      // auto` would otherwise let a terminal that has not refit yet push a
      // scrollbar into the pane instead of being clipped.
      style={{ overflow: "hidden" }}
    >
      {children}
    </Panel>
  );
}

/** 2px divider, lit with the accent border whenever it is live: hovered, being
 *  dragged, or holding keyboard focus.
 *
 *  The state comes off the library's own `data-separator` attribute rather than
 *  CSS `:hover`: it maintains a hit target far wider than the 2px line (down to
 *  the pointer-precision minimum), so a plain `:hover` rule would leave the
 *  divider grabbable in a band where it never lights up.
 *
 *  `focus` matters as much as the other two — the separator is tabbable and
 *  resizable with the arrow keys, so without it that whole path runs with no
 *  affordance at all. */
function PaneSeparator({ direction }: { direction: SplitDirection }) {
  return (
    <Separator
      className={cn(
        "shrink-0 bg-border transition-colors",
        "data-[separator=hover]:bg-border-active data-[separator=active]:bg-border-active data-[separator=focus]:bg-border-active",
        direction === "row"
          ? "w-0.5 cursor-col-resize"
          : "h-0.5 cursor-row-resize",
      )}
    />
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center px-6">
      <p className="max-w-sm text-center text-xs italic text-fg-muted">
        {message}
      </p>
    </div>
  );
}
