/** Roc, expanded — the main-area surface the widget opens into.
 *
 *  Takes the RocDock's place through the same swap RocPlan uses: the dock stays
 *  MOUNTED behind `hidden`, so a session spent talking to Roc costs no terminal
 *  a single byte, and `arePaneChordsBlocked` stands the pane chords down because
 *  `mainView !== "terminals"` (this view holds a text box; ⌘W behind it would
 *  close a pane the user cannot see).
 *
 *  Three regions, left to right: the sessions rail — every pane in every
 *  workspace, because talking to many at once is the point — the stage, and the
 *  live terminal of whichever session the rail has focused. Their split is
 *  persisted in the editor store beside the shell's other divider; the store's
 *  value is a mount-time `defaultLayout`, and this view mounts fresh each time,
 *  so it lands where the user left it. */

import { Group, Panel, Separator } from "react-resizable-panels";
import { PanelsTopLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore, useRocStore, useRocViewLayout } from "@/stores";
import { LiveTerminal } from "@/views/Roc/LiveTerminal";
import { RocStage } from "@/views/Roc/RocStage";
import { SessionsRail } from "@/views/Roc/SessionsRail";

const RAIL = "roc-rail";
const STAGE = "roc-stage";
const LIVE = "roc-live";

const DEFAULT_LAYOUT = { [RAIL]: 22, [STAGE]: 44, [LIVE]: 34 };

export function RocView() {
  const layout = useRocViewLayout();
  const setLayout = useEditorStore((s) => s.setRocViewLayout);
  const focusedRail = useRocStore((s) => s.focusedRailTerminalId);
  const setExpanded = useRocStore((s) => s.setExpanded);

  return (
    <div className="absolute inset-0 flex flex-col bg-surface-0">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Roc
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="text-xs text-fg-secondary">Talk to your agents</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          title="Back to terminals (⌘⇧R)"
          aria-label="Back to terminals"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary"
        >
          <PanelsTopLeft className="h-3.5 w-3.5" />
          Terminals
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <Group
          id="roc-view-horizontal"
          orientation="horizontal"
          className="absolute inset-0"
          defaultLayout={layout ?? DEFAULT_LAYOUT}
          // Drag end only, like the dock's groups: `onLayoutChange` (no d)
          // fires per pointer move and would put a store write, and an
          // autosave, on every frame of a drag.
          onLayoutChanged={setLayout}
        >
          <Panel id={RAIL} defaultSize="22%" minSize="14%" maxSize="40%">
            <SessionsRail />
          </Panel>
          <RocSeparator />
          <Panel id={STAGE} defaultSize="44%" minSize="24%" className="min-w-0">
            <RocStage />
          </Panel>
          <RocSeparator />
          <Panel id={LIVE} defaultSize="34%" minSize="20%" className="min-w-0">
            <LiveTerminal terminalId={focusedRail} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function RocSeparator() {
  return (
    <Separator
      className={cn(
        "w-px shrink-0 cursor-col-resize bg-border transition-colors",
        "data-[separator=hover]:bg-border-active data-[separator=active]:bg-border-active data-[separator=focus]:bg-border-active",
      )}
    />
  );
}
