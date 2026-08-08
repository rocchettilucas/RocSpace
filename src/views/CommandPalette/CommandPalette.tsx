/** ⌘K — one box that reaches every action in the app.
 *
 *  The list is not this component's: it comes from `lib/commands/registry`,
 *  which each area fills with the actions it owns. What lives here is the
 *  surface — search, grouping, and the keyboard model — plus the one rule that
 *  makes a palette trustworthy: **`enabled()` is asked once, when the palette
 *  opens.** A snapshot rather than a live list, because a result that appears or
 *  disappears under a cursor the user is already moving is how a palette runs
 *  the wrong command.
 *
 *  Escape is handled on the input rather than by `ModalShell`'s document
 *  listener: the shell deliberately stands down while a text field has the
 *  keyboard (Escape there means "abandon what I typed"), and this dialog IS its
 *  text field, so the two meanings coincide — the same arrangement the Save
 *  session prompt uses. */

import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, highlightRuns } from "@/lib/commands/filter";
import {
  allCommands,
  COMMAND_GROUPS,
  registerCommands,
  type CommandGroup,
} from "@/lib/commands/registry";
import { cn } from "@/lib/utils";
import { useUIStore, useWorkspaces, useWorkspacesStore } from "@/stores";
import { builtInCommands } from "@/views/CommandPalette/builtins";
import { ModalShell } from "@/views/Workspaces/ModalShell";
import type { CommandMatch } from "@/lib/commands/filter";

/** Register RocSpace's own actions for as long as this is mounted.
 *
 *  Re-registered when the workspace roster changes, because one of the actions
 *  is "switch to <name>" and there is one per row. Keyed on a SIGNATURE of the
 *  roster rather than on the array: the workspaces array gets a new identity
 *  whenever anything inside one changes — a divider drag rewrites a ratio on
 *  every frame — and re-registering forty commands per frame is work nobody
 *  asked for. Ids and names are the only parts these actions read.
 *
 *  Mounted on the palette's GATE rather than inside the dialog: the registry
 *  has to be full before ⌘K, not because of it. */
function useBuiltInCommands(): void {
  const signature = useWorkspaces()
    .map((w) => `${w.id}:${w.name}`)
    .join(" ");

  useEffect(() => {
    // Read fresh rather than closing over the array the signature came from:
    // the string is the dependency, and the roster it describes is whatever
    // the store holds at the moment this runs.
    return registerCommands(
      builtInCommands(useWorkspacesStore.getState().workspaces),
    );
  }, [signature]);
}

export function CommandPalette() {
  useBuiltInCommands();
  const isOpen = useUIStore((s) => s.isCommandPaletteOpen);
  if (!isOpen) return null;
  return <CommandPaletteDialog />;
}

interface Section {
  group: CommandGroup;
  matches: CommandMatch[];
}

/** Exported for tests; app code renders `CommandPalette`. Mounted only while
 *  open, so the query starts empty and `enabled()` is asked exactly once. */
export function CommandPaletteDialog() {
  const close = useUIStore((s) => s.closeCommandPalette);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The snapshot. `allCommands()` and every `enabled()` run once, on mount.
  const available = useMemo(
    () => allCommands().filter((command) => command.enabled?.() ?? true),
    [],
  );

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(
    () => filterCommands(available, query),
    [available, query],
  );

  // Grouped for display, flat for the keyboard. Both derive from one pass so
  // the index the arrows move through is exactly the order on screen — the two
  // going out of step is how Enter runs the row above the highlighted one.
  const sections = useMemo<Section[]>(() => {
    const byGroup = new Map<CommandGroup, CommandMatch[]>();
    for (const match of matches) {
      const bucket = byGroup.get(match.command.group);
      if (bucket) bucket.push(match);
      else byGroup.set(match.command.group, [match]);
    }
    return COMMAND_GROUPS.filter((group) => byGroup.has(group)).map(
      (group) => ({ group, matches: byGroup.get(group)! }),
    );
  }, [matches]);

  const flat = useMemo(
    () => sections.flatMap((section) => section.matches),
    [sections],
  );

  const active = flat[activeIndex] ?? null;
  const activeId = active ? optionId(active.command.id) : undefined;

  // Keep the highlighted row on screen when the arrows walk past the fold.
  // Found by its selected state rather than by id: command ids are kebab with
  // dots and colons in them (`settings.theme:tokyo-night`), which an id
  // selector would need escaping for, and there is exactly one selected row.
  useEffect(() => {
    if (!activeId) return;
    const el = listRef.current?.querySelector('[aria-selected="true"]');
    // jsdom does not implement scrolling; optional rather than mocked, so the
    // suite exercises the same line the app runs.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const runActive = () => {
    if (!active) return;
    // Closed first: the palette has done its job the instant a choice is made,
    // and an action that opens another dialog should not have to render behind
    // this one. The action still runs — React applies the close after the
    // handler returns.
    close();
    void active.command.run();
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
    setActiveIndex((i) => (i + delta + flat.length) % flat.length);
  };

  return (
    <ModalShell
      title="Command palette"
      onClose={close}
      initialFocusRef={inputRef}
      width="w-[600px]"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="command-palette-list"
          aria-activedescendant={activeId}
          aria-label="Search commands"
          placeholder="Type a command…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Typing re-ranks the list, so the highlight goes back to the top.
            // Reset here rather than in an effect on `query`: the keystroke is
            // what invalidated the cursor, and an effect would let one render
            // paint with an index that names a different command.
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              runActive();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          className={cn(
            "rounded-input border border-border bg-surface-0 px-2.5 py-2",
            "text-sm text-fg-primary outline-none focus:border-border-active",
          )}
        />

        {flat.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-fg-muted">
            No command matches “{query.trim()}”. Settings › Shortcuts lists
            every key RocSpace binds.
          </p>
        ) : (
          <div
            ref={listRef}
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            className="-mx-1 max-h-[50vh] overflow-y-auto px-1"
          >
            {sections.map((section) => (
              <div key={section.group} role="group" aria-label={section.group}>
                <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-muted first:pt-0">
                  {section.group}
                </p>
                {section.matches.map((match) => (
                  <CommandRow
                    key={match.command.id}
                    match={match}
                    active={match === active}
                    onPick={() => {
                      setActiveIndex(flat.indexOf(match));
                      close();
                      void match.command.run();
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

const optionId = (commandId: string) => `command-option-${commandId}`;

function CommandRow({
  match,
  active,
  onPick,
}: {
  match: CommandMatch;
  active: boolean;
  onPick: () => void;
}) {
  const { command, titleIndices } = match;
  return (
    <div
      id={optionId(command.id)}
      role="option"
      aria-selected={active}
      // Mouse only: the arrows drive selection and the input keeps the
      // keyboard, so a row must never become a tab stop of its own — Tab in
      // this dialog belongs to the shell's trap, not to forty rows.
      onClick={onPick}
      onMouseDown={(e) => {
        // Keep focus in the input: a blur here would take `aria-activedescendant`
        // with it and drop the caret the user is still typing into.
        e.preventDefault();
      }}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-3 rounded-input px-2 py-1.5",
        active ? "bg-accent-soft text-fg-primary" : "text-fg-secondary",
      )}
    >
      <span className="min-w-0 truncate text-xs">
        {highlightRuns(command.title, titleIndices).map((run, i) =>
          run.hit ? (
            <span key={i} className="font-semibold text-accent">
              {run.text}
            </span>
          ) : (
            <span key={i}>{run.text}</span>
          ),
        )}
      </span>
      {command.shortcut ? (
        <kbd className="shrink-0 rounded-input border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
          {command.shortcut}
        </kbd>
      ) : null}
    </div>
  );
}
