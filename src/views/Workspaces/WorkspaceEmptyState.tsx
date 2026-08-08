/** What the app is before it holds anything.
 *
 *  Replaces the RocLaunch wizard. Four screens of project / groups / agents /
 *  review became one modal, so the thing that used to stand between the user
 *  and the app is now a card that names the chord and gets out of the way —
 *  and it is reachable again later, which the wizard never was. */

import { Plus } from "lucide-react";
import rocLogo from "@/assets/roc-logo.png";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores";

export function WorkspaceEmptyState() {
  const openWorkspaceModal = useUIStore((s) => s.openWorkspaceModal);

  return (
    <div className="grid h-screen w-screen place-items-center bg-surface-0 text-fg-primary">
      <div
        className={cn(
          "flex w-[380px] max-w-full flex-col items-center gap-3 rounded-xl border border-border",
          "bg-surface-1 px-10 py-9 text-center",
        )}
      >
        <img
          src={rocLogo}
          alt=""
          draggable={false}
          className="h-10 w-10 select-none object-contain"
        />
        <h1 className="text-base font-semibold">No workspaces</h1>
        <p className="text-xs leading-relaxed text-fg-secondary">
          Press{" "}
          <kbd className="rounded-input border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
            ⌘T
          </kbd>{" "}
          to create one — pick a folder, a layout, and the agents to open it
          with.
        </p>
        <button
          type="button"
          onClick={openWorkspaceModal}
          className="mt-1 flex items-center gap-1.5 rounded-input bg-accent px-3.5 py-2 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          New workspace
        </button>
      </div>
    </div>
  );
}
