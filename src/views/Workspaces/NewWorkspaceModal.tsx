/** ⌘T — the one way to make a workspace.
 *
 *  Three decisions, in the order they matter: how many panes, which directory,
 *  which agents. Everything has a default, so Enter on an untouched modal is a
 *  legitimate answer (four panes of the user's default agent, no directory) —
 *  the modal exists to be *skipped* quickly as much as to be filled in.
 *
 *  Focus management, the scrim and Escape come from `ModalShell`. */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, FolderOpen, X } from "lucide-react";
import { useState } from "react";
import { AGENT_NAME, agentChoices } from "@/lib/agentLabels";
import { buildBalancedTree, type PaneNode } from "@/lib/paneTree";
import { forgetRecent, getRecents, rememberRecent } from "@/lib/recents";
import { cn } from "@/lib/utils";
import { useSettingsStore, useUIStore, useWorkspacesStore } from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";
import type { AgentType } from "@/lib/bindings";

/** The pane counts a template offers. Each preview is drawn from the real
 *  balanced tree the store will build, so a tile cannot promise a layout the
 *  workspace does not open with. */
const TEMPLATES: ReadonlyArray<{ panes: 1 | 2 | 4 | 6 | 8; caption: string }> =
  [
    { panes: 1, caption: "Single pane" },
    { panes: 2, caption: "Side by side" },
    { panes: 4, caption: "2×2 grid layout" },
    { panes: 6, caption: "Six panes" },
    { panes: 8, caption: "4×2 grid layout" },
  ];

const DEFAULT_PANES = 4;

/** A dot per agent, so the checkbox list reads at a glance. Theme variables
 *  rather than the demo's hard-coded tints — everything else in RocSpace
 *  re-colours with the theme, and this has no reason not to. */
const AGENT_DOT: Record<AgentType, string> = {
  "claude-code": "var(--rs-purple)",
  codex: "var(--rs-info)",
  "open-code": "var(--rs-success)",
  shell: "var(--rs-text-3)",
  custom: "var(--rs-warning)",
};

export function NewWorkspaceModal() {
  const isOpen = useUIStore((s) => s.isWorkspaceModalOpen);
  if (!isOpen) return null;
  return <NewWorkspaceDialog />;
}

/** Exported for tests; app code renders `NewWorkspaceModal`. Mounted only
 *  while open, so every piece of draft state below starts fresh each time. */
export function NewWorkspaceDialog() {
  const close = useUIStore((s) => s.closeWorkspaceModal);
  const createWorkspace = useWorkspacesStore((s) => s.createWorkspace);
  const defaultAgent = useSettingsStore((s) => s.agentDefaults.agentType);

  // Recents are read, not subscribed to: the list only changes here, and it
  // cannot change while the modal is up except by the forget button below,
  // which re-reads. See `lib/recents.ts` for why that module is not a store.
  const [recents, setRecents] = useState(getRecents);

  const [paneCount, setPaneCount] = useState<1 | 2 | 4 | 6 | 8>(DEFAULT_PANES);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentType[]>([defaultAgent]);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const toggleAgent = (type: AgentType) =>
    setAgents((current) =>
      current.includes(type)
        ? current.filter((t) => t !== type)
        : [...current, type],
    );

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select project folder",
      });
      if (typeof selected === "string") setProjectPath(selected);
    } catch (err) {
      console.warn("[workspaces] directory picker failed:", err);
    }
  };

  const handleForget = (path: string) => {
    forgetRecent(path);
    setRecents(getRecents());
  };

  const handleCreate = () => {
    if (projectPath) rememberRecent(projectPath);
    createWorkspace({
      projectPath,
      paneCount,
      // Empty means "the user unchecked everything", which is not a workspace
      // of zero agents — it is the default, the same as never having opened
      // the section.
      agentTypes: agents.length > 0 ? agents : [defaultAgent],
    });
    close();
  };

  return (
    <ModalShell
      title="New workspace"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            onClick={close}
            className="rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            className="rounded-input bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            Create workspace
          </button>
        </>
      }
    >
      <Field label="Layout">
        <div
          role="radiogroup"
          aria-label="Layout"
          className="flex flex-wrap gap-2"
        >
          {TEMPLATES.map((template) => (
            <TemplateTile
              key={template.panes}
              panes={template.panes}
              caption={template.caption}
              selected={template.panes === paneCount}
              onSelect={() => setPaneCount(template.panes)}
            />
          ))}
        </div>
      </Field>

      <Field label="Directory">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate rounded-input border border-border bg-surface-2/60 px-2.5 py-1.5",
              "font-mono text-[11px]",
              projectPath ? "text-fg-primary" : "text-fg-muted",
            )}
            title={projectPath ?? undefined}
          >
            {projectPath ?? "No directory — panes run from your home folder"}
          </span>
          <button
            type="button"
            onClick={() => void handleBrowse()}
            className="flex shrink-0 items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1.5 text-xs text-fg-primary hover:bg-surface-3"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse
          </button>
        </div>

        {recents.length > 0 ? (
          <ul aria-label="Recent directories" className="flex flex-col">
            {recents.map((recent) => (
              <li key={recent.path} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => setProjectPath(recent.path)}
                  title={recent.path}
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-input px-2 py-1 text-left font-mono text-[11px]",
                    recent.path === projectPath
                      ? "text-fg-primary"
                      : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
                  )}
                >
                  {recent.path}
                </button>
                <button
                  type="button"
                  aria-label={`Forget ${recent.path}`}
                  title="Remove from recents"
                  onClick={() => handleForget(recent.path)}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Field>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={agentsOpen}
          onClick={() => setAgentsOpen((v) => !v)}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted hover:text-fg-secondary"
        >
          {agentsOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Agents
          <span className="ml-1 normal-case tracking-normal text-fg-muted">
            {agents.map((a) => AGENT_NAME[a]).join(", ") || "none"}
          </span>
        </button>
        {agentsOpen ? (
          <div className="flex flex-col gap-0.5 pl-4">
            {/* The offerable types, plus anything already ticked — which is
                how a stored default of "Custom" stays visible and unpickable
                at the same time. See `agentChoices`. */}
            {agentChoices(...agents).map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1 text-xs text-fg-secondary hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={agents.includes(type)}
                  onChange={() => toggleAgent(type)}
                  className="h-3 w-3 accent-accent"
                />
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: AGENT_DOT[type] }}
                />
                {AGENT_NAME[type]}
              </label>
            ))}
            <p className="px-2 pt-1 text-[10px] leading-relaxed text-fg-muted">
              Panes take these in turn, so two agents across four panes give you
              two of each.
            </p>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function TemplateTile({
  panes,
  caption,
  selected,
  onSelect,
}: {
  panes: number;
  caption: string;
  selected: boolean;
  onSelect: () => void;
}) {
  // Fake ids: the preview is about shape, and `buildBalancedTree` is what the
  // store will call with the real ones.
  const tree = buildBalancedTree(
    Array.from({ length: panes }, (_, i) => `p${i}`),
  );

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${panes} pane${panes === 1 ? "" : "s"} — ${caption}`}
      onClick={onSelect}
      className={cn(
        "flex w-[96px] flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-surface-2/40 text-fg-muted hover:border-border-hover hover:text-fg-secondary",
      )}
    >
      <span className="flex h-9 w-full">
        {tree ? <TreePreview node={tree} /> : null}
      </span>
      <span className="text-[11px] font-medium tabular-nums text-fg-primary">
        {panes}
      </span>
      <span className="text-center text-[9px] leading-tight text-fg-muted">
        {caption}
      </span>
    </button>
  );
}

/** The template's shape, drawn from the tree itself. `bg-current` picks up the
 *  tile's text colour, so a selected tile's preview is accent-tinted for free. */
function TreePreview({ node }: { node: PaneNode }) {
  if (node.kind === "leaf") {
    return <span className="flex-1 rounded-[2px] bg-current opacity-40" />;
  }
  return (
    <span
      className={cn(
        "flex flex-1 gap-[2px]",
        node.direction === "row" ? "flex-row" : "flex-col",
      )}
    >
      <TreePreview node={node.first} />
      <TreePreview node={node.second} />
    </span>
  );
}
