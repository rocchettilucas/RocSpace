import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { commands } from "@/lib/bindings";
import { cachedFile, forgetFile, markSaved } from "@/lib/fileContents";
import { LIMITS } from "@/lib/limits";
import { useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Code editor state — open tabs, active tab, and the right-dock mode.
 *
 *  This store is persisted (via `src/lib/persistence.ts`). The right-dock
 *  mode lives here rather than in `useUIStore` so it survives reloads
 *  alongside the tab list — `useUIStore` is documented as ephemeral. */

export type RightDockMode = "inspector" | "browser" | "editor" | "git";

export interface EditorTab {
  /** Absolute, canonicalized path returned by fs_read_file. */
  path: string;
  /** Display name (basename). Captured at open time so we don't re-stat on each render. */
  name: string;
  /** Line to reveal on next paint; cleared by MonacoPane after revealing. */
  pendingLine?: number;
}

interface EditorState {
  rightDockMode: RightDockMode;
  tabs: EditorTab[];
  activePath: string | null;
  /** Whether the right-side dock panel is collapsed (full terminal focus). */
  rightPanelCollapsed: boolean;
  /** Whether the workspace sidebar is collapsed. Beside `rightPanelCollapsed`
   *  rather than in `useUIStore` for the reason that store gives: it is a
   *  preference that outlives the session, and the UI store is ephemeral. The
   *  two dividers are the same kind of thing and answer to the same rules. */
  sidebarCollapsed: boolean;
  /** Address the Browser mode shows. Here rather than on the workspace because
   *  it belongs to the right panel, which is one panel for the whole window —
   *  the preview does not switch when the dock does. Was a per-profile field
   *  until Phase 2 retired profiles. */
  browserUrl: string;
  /** Unsaved buffers, by absolute path. A key here IS the dirty flag, and the
   *  value is what ⌘S would write. The baseline it differs from lives in
   *  `@/lib/fileContents` — the bytes last seen on disk — so this holds only
   *  what the user typed and nothing that could be re-read.
   *
   *  Deliberately NOT persisted (`captureSnapshot` names the editor fields it
   *  writes and this is not one of them): the snapshot is a layout, and file
   *  contents in it would be a second, silent, unversioned copy of the user's
   *  work that nothing ever reconciles with the real one. */
  dirtyByPath: Record<string, string>;
  /** How the Roc view's three regions are split — rail | stage | live terminal.
   *  `null` until the user drags a divider, which is what "use the defaults"
   *  means.
   *
   *  Here rather than in `useRocStore` for the one reason that store is
   *  ephemeral and this is not: a split the user dragged is a preference, and
   *  the Roc store holds a conversation. It sits beside `rightPanelCollapsed`,
   *  which is the same kind of thing about the shell's other divider. */
  rocViewLayout: Record<string, number> | null;
}

interface EditorActions {
  setRightDockMode: (m: RightDockMode) => void;
  setBrowserUrl: (url: string) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  toggleRightPanelCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setRocViewLayout: (layout: Record<string, number>) => void;
  /** Open or focus a file. If already open, jumps to `line` if provided. */
  openFile: (path: string, line?: number) => void;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  /** Cleared by MonacoPane after revealing the line. */
  clearPendingLine: (path: string) => void;

  /** Record what the editor is showing for `path`. `baseline` is the bytes on
   *  disk: typing back to them clears the dirty flag rather than leaving a
   *  buffer that is identical to the file it would overwrite. */
  setBuffer: (path: string, text: string, baseline: string) => void;
  /** Throw the unsaved buffer away; the editor falls back to the baseline. */
  revert: (path: string) => void;
  /** Write one file. Defaults to the active tab. Resolves true when there is
   *  nothing to save or the save landed, false when it failed — the caller
   *  (the close-confirm dialog) needs to know before it closes the tab. */
  save: (path?: string) => Promise<boolean>;
  /** Write every dirty buffer. Reports once, at the end. */
  saveAll: () => Promise<void>;
}

/** Hard cap on simultaneous tabs. We don't aim to beat VSCode's tab strip;
 *  this is just to keep the persisted snapshot bounded. */
const MAX_TABS = LIMITS.editorTabs;

export const DEFAULT_BROWSER_URL = "http://localhost:3000";

const initialState: EditorState = {
  rightDockMode: "inspector",
  tabs: [],
  activePath: null,
  rightPanelCollapsed: false,
  sidebarCollapsed: false,
  browserUrl: DEFAULT_BROWSER_URL,
  rocViewLayout: null,
  dirtyByPath: {},
};

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Where a save is allowed to write.
 *
 *  The ACTIVE workspace's directory, which is the same root the tree browsed
 *  and `useFileContents` read through — Rust refuses anything that does not
 *  descend from it, so a tab opened in another workspace cannot be saved from
 *  here any more than it can be read here. One root, one answer, and the
 *  refusal comes from the sandbox rather than from a second rule. */
function activeProjectRoot(): string | null {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  return (
    workspaces.find((w) => w.id === activeWorkspaceId)?.projectPath ?? null
  );
}

/** Writes in flight, by path, each under the token that identifies it.
 *
 *  Module-level rather than store state because nothing renders it and nothing
 *  outside these two actions may set it: it exists so that `setBuffer` and
 *  `save` can agree about a window in which the answer to "is this file dirty?"
 *  is not knowable yet. The baseline is the bytes on disk, a save is on its way
 *  to changing them, and until it lands or fails there are two candidates for
 *  what the buffer should be compared against.
 *
 *  The token, rather than a bare flag, is what makes a second ⌘S during the
 *  first one safe: only the newest save of a path moves the baseline and
 *  settles the buffer, so a slower earlier write cannot land afterwards and
 *  report a state that has been superseded. */
const savesInFlight = new Map<string, number>();
let saveSequence = 0;

/** Settle `path`'s buffer against the bytes that are on disk now that the round
 *  trip is over — the text that was written, or the untouched baseline when the
 *  write was refused.
 *
 *  A buffer equal to the file is not an edit and goes; anything else is one and
 *  stays, whether it was typed before the save or during it. This is the same
 *  measurement `setBuffer` makes, deferred to the moment the answer exists. */
function settleBuffer(path: string, onDisk: string | undefined): void {
  useEditorStore.setState((s) => {
    if (s.dirtyByPath[path] === onDisk) delete s.dirtyByPath[path];
  });
}

const message = (err: unknown): string =>
  typeof err === "string"
    ? err
    : err instanceof Error
      ? err.message
      : String(err);

export const useEditorStore = create<EditorState & EditorActions>()(
  devtools(
    immer((set, get) => ({
      ...initialState,

      setRightDockMode: (m) =>
        set((s) => {
          s.rightDockMode = m;
        }),

      setBrowserUrl: (url) =>
        set((s) => {
          s.browserUrl = url;
        }),

      setRightPanelCollapsed: (collapsed) =>
        set((s) => {
          s.rightPanelCollapsed = collapsed;
        }),

      toggleRightPanelCollapsed: () =>
        set((s) => {
          s.rightPanelCollapsed = !s.rightPanelCollapsed;
        }),

      setSidebarCollapsed: (collapsed) =>
        set((s) => {
          s.sidebarCollapsed = collapsed;
        }),

      toggleSidebarCollapsed: () =>
        set((s) => {
          s.sidebarCollapsed = !s.sidebarCollapsed;
        }),

      setRocViewLayout: (layout) =>
        set((s) => {
          s.rocViewLayout = layout;
        }),

      openFile: (path, line) => {
        // Paths the cap pushed out. Collected inside the producer and acted on
        // after it: dropping a cached read is not store state, and an immer
        // recipe is no place for a side effect.
        const evicted: string[] = [];
        set((s) => {
          const existing = s.tabs.find((t) => t.path === path);
          if (existing) {
            if (line !== undefined) existing.pendingLine = line;
            s.activePath = path;
            return;
          }
          // Bound the tab list: drop the oldest tab that is neither active nor
          // holding unsaved work. The cap keeps the persisted snapshot small;
          // an unsaved buffer is the user's only copy of an edit, and no cap is
          // worth losing one to. So when every other tab is dirty the list is
          // allowed past the cap, and comes back under it as soon as one of
          // them is saved or closed.
          if (s.tabs.length >= MAX_TABS) {
            const dropIdx = s.tabs.findIndex(
              (t) =>
                t.path !== s.activePath && s.dirtyByPath[t.path] === undefined,
            );
            if (dropIdx >= 0) {
              const [dropped] = s.tabs.splice(dropIdx, 1);
              if (dropped) evicted.push(dropped.path);
            }
          }
          s.tabs.push({
            path,
            name: basename(path),
            pendingLine: line,
          });
          s.activePath = path;
        });
        for (const gone of evicted) forgetFile(gone);
      },

      closeTab: (path) => {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.path === path);
          if (idx < 0) return;
          s.tabs.splice(idx, 1);
          // A buffer with no tab is unreachable — nothing would ever show it,
          // save it or ask about it. The confirmation that guards this is the
          // tab strip's; by the time the store is told, the answer was given.
          delete s.dirtyByPath[path];
          if (s.activePath !== path) return;
          // Pick the neighbor that survived: prefer right, fall back to left.
          if (s.tabs.length === 0) {
            s.activePath = null;
          } else {
            s.activePath = s.tabs[Math.min(idx, s.tabs.length - 1)]!.path;
          }
        });
        // Drop the baseline too, so reopening re-reads. It used to be kept for
        // the session — cheap, and nothing else wrote to the file. Now the app
        // itself does, and so do the agents in the panes beside it.
        forgetFile(path);
      },

      setActive: (path) =>
        set((s) => {
          if (s.tabs.some((t) => t.path === path)) {
            s.activePath = path;
          }
        }),

      clearPendingLine: (path) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.path === path);
          if (tab) tab.pendingLine = undefined;
        }),

      setBuffer: (path, text, baseline) =>
        set((s) => {
          // Typing back to the file leaves nothing to save — EXCEPT while a
          // write of this path is in flight, when `baseline` is the version
          // being replaced rather than the one that will be on disk in a
          // moment. Deleting the buffer there is how an edit made during a
          // save gets silently undone: `markSaved` moves the baseline over the
          // correction, the editor shows the saved bytes, and no dot says
          // anything happened. So the buffer is held and `save` settles it
          // against what actually landed.
          if (text === baseline && !savesInFlight.has(path)) {
            delete s.dirtyByPath[path];
          } else {
            s.dirtyByPath[path] = text;
          }
        }),

      revert: (path) =>
        set((s) => {
          delete s.dirtyByPath[path];
        }),

      save: async (path) => {
        const target = path ?? get().activePath;
        if (!target) return true;
        const text = get().dirtyByPath[target];
        // Nothing to write is a success: ⌘S on a clean file is a reflex, not a
        // request, and answering it with a failure would be a lie.
        if (text === undefined) return true;

        const root = activeProjectRoot();
        if (!root) {
          useToastsStore.getState().push({
            message: `Can't save ${basename(target)} — this workspace has no project directory.`,
            tone: "warn",
          });
          return false;
        }

        // What the file says now, kept for the failure path: a refused write
        // leaves the disk alone, so this is still what "nothing to save" means
        // if the user types their way back to it while we are asking.
        const before = cachedFile(target)?.content;
        const token = ++saveSequence;
        savesInFlight.set(target, token);

        let failure: unknown = null;
        try {
          await commands.fsWriteFile(root, target, text);
        } catch (err) {
          failure = err;
        }
        // Superseded by a later ⌘S on the same file? Then this write's idea of
        // what is on disk is already stale, and the newer one owns both the
        // baseline and the buffer. Say how this one went and stand down.
        const newest = savesInFlight.get(target) === token;
        if (newest) savesInFlight.delete(target);

        if (failure !== null) {
          // Rust's own words: "outside the project root", "path is a symlink",
          // "is not writable". Every one of them tells the user something ours
          // would not.
          useToastsStore.getState().push({
            message: `Could not save ${basename(target)}: ${message(failure)}`,
            tone: "warn",
          });
          if (newest) settleBuffer(target, before);
          return false;
        }

        if (newest) {
          // The bytes on disk are now the buffer, so the baseline moves with
          // them — otherwise the next external-change check reads our own save
          // as somebody else's edit.
          markSaved(target, text);
          settleBuffer(target, text);
        }
        return true;
      },

      saveAll: async () => {
        const paths = Object.keys(get().dirtyByPath);
        if (paths.length === 0) {
          useToastsStore
            .getState()
            .push({ message: "Nothing to save — no unsaved changes." });
          return;
        }
        // Sequential rather than `Promise.all`: these are writes to the user's
        // project, and a burst of failures should report as one line rather
        // than as whatever order the round trips happened to finish in.
        let saved = 0;
        for (const path of paths) {
          if (await get().save(path)) saved += 1;
        }
        const failed = paths.length - saved;
        // Each failure has already said what went wrong, in its own words; this
        // is the count, and only when there is more than one file's worth.
        if (failed === 0) {
          useToastsStore.getState().push({
            message: saved === 1 ? "Saved 1 file." : `Saved ${saved} files.`,
          });
        } else if (saved > 0) {
          useToastsStore.getState().push({
            message: `Saved ${saved} of ${paths.length} files.`,
            tone: "warn",
          });
        }
      },
    })),
    { name: "editor" },
  ),
);

// Selectors --------------------------------------------------------------

export const useRightDockMode = () => useEditorStore((s) => s.rightDockMode);
export const useRightPanelCollapsed = () =>
  useEditorStore((s) => s.rightPanelCollapsed);
export const useSidebarCollapsed = () =>
  useEditorStore((s) => s.sidebarCollapsed);
export const useRocViewLayout = (): Record<string, number> | null =>
  useEditorStore((s) => s.rocViewLayout);
export const useEditorTabs = () => useEditorStore((s) => s.tabs);
export const useActiveEditorPath = () => useEditorStore((s) => s.activePath);
export const useActiveEditorTab = (): EditorTab | null =>
  useEditorStore((s) =>
    s.activePath ? (s.tabs.find((t) => t.path === s.activePath) ?? null) : null,
  );

/** The whole map, for a component that asks about several paths (the tab
 *  strip). Never derive an array in a selector — a fresh one every render is a
 *  re-render loop. */
export const useDirtyBuffers = (): Record<string, string> =>
  useEditorStore((s) => s.dirtyByPath);

export const useIsDirty = (path: string | null): boolean =>
  useEditorStore((s) => path !== null && s.dirtyByPath[path] !== undefined);

/** The unsaved text for `path`, or undefined when the file is clean. This is
 *  what the editor shows: the buffer when there is one, the baseline when there
 *  is not. */
export const useDirtyBuffer = (path: string | null): string | undefined =>
  useEditorStore((s) => (path === null ? undefined : s.dirtyByPath[path]));

/** Imperative form, for keydown handlers and palette `enabled()` checks. */
export const hasUnsavedBuffers = (): boolean =>
  Object.keys(useEditorStore.getState().dirtyByPath).length > 0;
