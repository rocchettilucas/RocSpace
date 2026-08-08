import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { isConfirmOpen } from "@/stores/confirm";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Ephemeral UI state — focus, highlight, maximize, the new-workspace modal,
 * the command palette, and the (still unbuilt) modal stack. NOT persisted to
 * disk (workspaces + terminals are the persistent surface).
 *
 * Panel sizing and collapse state deliberately do NOT live here:
 * react-resizable-panels owns sizing in `AppShell`, and the right panel's
 * collapse flag lives in `useEditorStore` because it persists. */

type ModalKind =
  | { type: "close-workspace"; workspaceId: string }
  | { type: "delete-terminal"; terminalId: string }
  | { type: "permission-prompt"; terminalId: string; message: string };

/** Sections of the Settings overlay. The order here is the order the nav
 *  renders them in; labels and icons live in `views/Settings/SettingsNav.tsx`
 *  (a `Record` over this union, so a new section can't be half-added). */
export type SettingsSectionId =
  | "appearance"
  | "terminal"
  | "agents"
  | "notifications"
  | "voice"
  | "shortcuts"
  | "history"
  | "about";

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

/** What the main area (the RocDock column) is showing.
 *
 *  A swap rather than an overlay: the terminals stay mounted underneath, so the
 *  board — or Roc's expanded view — is somewhere you go and come back from
 *  without a pane losing a byte. Settings is still an overlay on top of
 *  whichever of these is up.
 *
 *  Every member that is not `"terminals"` is a surface the pane chords must
 *  stand down for; `arePaneChordsBlocked` asks it that way round so adding one
 *  here is the whole change. */
export type MainView = "terminals" | "rocplan" | "roc" | "rocmind";

/** Which card the RocPlan editor is open on. `taskId: null` is the create form
 *  — one dialog for both, because they ask the same questions. */
export interface TaskEditorTarget {
  projectPath: string;
  taskId: string | null;
}

/** The Git panel's three dialogs: switch or create a branch, add a worktree,
 *  hand a diff to an agent.
 *
 *  One field rather than three booleans because they are mutually exclusive by
 *  construction — each is opened from a button in the same header — and because
 *  `blockingModalOpen` below then has one thing to ask about instead of three
 *  it could forget one of. */
export type GitDialogKind = "branch" | "worktree" | "review";
/** A question the code editor is asking about one file.
 *
 *  Both are about the same thing from two directions — a buffer that disagrees
 *  with the disk — so they share a slot: nothing sensible happens if a file is
 *  being closed and reconciled at once, and one slot makes that unrepresentable
 *  rather than merely unlikely.
 *
 *  The disk content the `external-change` answer needs is NOT here: it is a
 *  whole file, it is not UI state, and it already has somewhere to live
 *  (`@/lib/fileContents`'s stash). This names the question; that holds the
 *  evidence. */
export type EditorPrompt =
  | { type: "unsaved-close"; path: string }
  | { type: "external-change"; path: string };

interface UIState {
  /** Currently focused terminal across the whole app — drives RightPanel selection. */
  focusedTerminalId: string | null;
  /** Terminal briefly highlighted after a notification click. Auto-cleared after ~1800ms. */
  highlightedTerminalId: string | null;
  /** When set, only this terminal is rendered in the RocDock; the split tree is
   *  bypassed for the duration. The tree itself is untouched underneath, so
   *  this is a temporary "focus mode" the user pops in and out of without
   *  losing their layout. */
  maximizedTerminalId: string | null;
  /** ⌘K. This flag predates the revamp by two years as scaffolding with
   *  nothing bound to it; Phase 5 kept it rather than minting a new one — it
   *  already had the three actions, the tests and the right home (the palette
   *  is ephemeral, like everything else here). What it did NOT have was a
   *  place in `blockingModalOpen`, which is the half that matters: the palette
   *  is a real modal, and every other chord stands down while it is up. */
  isCommandPaletteOpen: boolean;
  /** Settings overlay — covers the RocDock area; the rest of the shell stays
   *  visible and mounted (terminals keep streaming behind it). */
  isSettingsOpen: boolean;
  /** Which section the overlay shows. Survives close/reopen on purpose: coming
   *  back to Settings lands where you left off. */
  settingsSection: SettingsSectionId;
  /** The New Workspace modal (⌘T). A flag rather than an entry in `modalStack`
   *  because it is a real modal with its own focus management, while the stack
   *  is still the unbuilt confirm-dialog queue. */
  isWorkspaceModalOpen: boolean;
  /** The "Save session as…" name prompt (⌘⇧S). Its own flag for the same
   *  reason, and separate from the one above because the two are different
   *  questions about different things — nothing ever wants both open. */
  isSaveSessionModalOpen: boolean;
  /** The ⌘P file finder. Its own flag beside the two above, for the same
   *  reason they are separate from each other: nothing ever wants two of these
   *  open, and a flag each is what makes that readable. */
  isQuickOpenOpen: boolean;
  /** What the editor is asking about a file, or null. Carries the path rather
   *  than being a boolean because "which file" is not something the dialog can
   *  ask the editor afterwards — the tab may already be gone. */
  editorPrompt: EditorPrompt | null;
  /** The "What's new" dialog. Announces itself once per changelog entry (see
   *  `WhatsNewModal`) and is reopenable from the palette and Settings › About;
   *  the flag is here rather than in settings because it is a thing on screen,
   *  and what settings persists is the *acknowledgement*, not the dialog. */
  isWhatsNewOpen: boolean;
  /** Terminals, the RocPlan board, Roc, or RocMind. Ephemeral like everything
   *  else here: the app opens on its panes, whatever it was last showing. */
  mainView: MainView;
  /** The RocPlan card editor, or null. Carries its target rather than being a
   *  boolean because "which card" is not something the board can be asked
   *  afterwards — the modal is mounted beside the shell, not inside a column. */
  taskEditor: TaskEditorTarget | null;
  /** Which of the Git panel's dialogs is up, or null. */
  gitDialog: GitDialogKind | null;
  /** LIFO stack so esc dismisses the top one. */
  modalStack: ModalKind[];
}

interface UIActions {
  focusTerminal: (id: string | null) => void;
  setHighlight: (id: string, ttlMs?: number) => void;
  maximizeTerminal: (id: string) => void;
  exitMaximize: () => void;
  toggleMaximizeTerminal: (id: string) => void;

  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  openWorkspaceModal: () => void;
  closeWorkspaceModal: () => void;

  openSaveSessionModal: () => void;
  closeSaveSessionModal: () => void;

  openQuickOpen: () => void;
  closeQuickOpen: () => void;

  openEditorPrompt: (prompt: EditorPrompt) => void;
  closeEditorPrompt: () => void;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;

  setMainView: (view: MainView) => void;

  /** Open the card editor. Omitting `taskId` (or passing null) is the create
   *  form; passing one edits that card. */
  openTaskEditor: (projectPath: string, taskId?: string | null) => void;
  closeTaskEditor: () => void;

  openGitDialog: (kind: GitDialogKind) => void;
  closeGitDialog: () => void;

  /** Open Settings, optionally jumping straight to a section. */
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  /** Gear-button behaviour: same section closes, a different one switches. */
  toggleSettings: (section?: SettingsSectionId) => void;
  setSettingsSection: (section: SettingsSectionId) => void;

  pushModal: (modal: ModalKind) => void;
  popModal: () => void;
  clearModals: () => void;
}

const initialState: UIState = {
  focusedTerminalId: null,
  highlightedTerminalId: null,
  maximizedTerminalId: null,
  isCommandPaletteOpen: false,
  isWorkspaceModalOpen: false,
  isSaveSessionModalOpen: false,
  isQuickOpenOpen: false,
  editorPrompt: null,
  isWhatsNewOpen: false,
  isSettingsOpen: false,
  settingsSection: DEFAULT_SETTINGS_SECTION,
  mainView: "terminals",
  taskEditor: null,
  gitDialog: null,
  modalStack: [],
};

/** Mirror the app-wide focus onto the workspace that owns the pane.
 *
 *  Two readers, two lifetimes: the inspector and the pane chords want "what is
 *  focused right now", which is ephemeral and app-wide; the workspace wants
 *  "which pane was I on", which is per-workspace and persisted, so switching
 *  away and back lands where the user left off. Writing both from one action is
 *  what keeps them from drifting — a `focusTerminal` that only moved the
 *  ephemeral one would leave every workspace remembering its first pane
 *  forever. */
function recordFocusOnWorkspace(terminalId: string | null): void {
  const { activeWorkspaceId, setFocusedTerminal } =
    useWorkspacesStore.getState();
  if (activeWorkspaceId) setFocusedTerminal(activeWorkspaceId, terminalId);
}

/** Module-level timer so rapid re-calls to setHighlight cancel the previous one. */
let _highlightTimer: ReturnType<typeof setTimeout> | null = null;

export const useUIStore = create<UIState & UIActions>()(
  devtools(
    immer((set) => ({
      ...initialState,

      focusTerminal: (id) =>
        set((s) => {
          s.focusedTerminalId = id;
          recordFocusOnWorkspace(id);
        }),

      maximizeTerminal: (id) =>
        set((s) => {
          s.maximizedTerminalId = id;
          // Also mark this terminal as focused so e.g. the inspector and
          // global "Stop"/"Launch" actions target the right pane.
          s.focusedTerminalId = id;
          recordFocusOnWorkspace(id);
        }),

      exitMaximize: () =>
        set((s) => {
          s.maximizedTerminalId = null;
        }),

      toggleMaximizeTerminal: (id) =>
        set((s) => {
          if (s.maximizedTerminalId === id) {
            s.maximizedTerminalId = null;
          } else {
            s.maximizedTerminalId = id;
            s.focusedTerminalId = id;
            recordFocusOnWorkspace(id);
          }
        }),

      setHighlight: (id, ttlMs = 1800) => {
        if (_highlightTimer) clearTimeout(_highlightTimer);
        set((s) => {
          s.highlightedTerminalId = id;
        });
        _highlightTimer = setTimeout(() => {
          set((s) => {
            s.highlightedTerminalId = null;
          });
          _highlightTimer = null;
        }, ttlMs);
      },

      openCommandPalette: () =>
        set((s) => {
          s.isCommandPaletteOpen = true;
        }),
      closeCommandPalette: () =>
        set((s) => {
          s.isCommandPaletteOpen = false;
        }),
      toggleCommandPalette: () =>
        set((s) => {
          s.isCommandPaletteOpen = !s.isCommandPaletteOpen;
        }),

      openWorkspaceModal: () =>
        set((s) => {
          s.isWorkspaceModalOpen = true;
        }),
      closeWorkspaceModal: () =>
        set((s) => {
          s.isWorkspaceModalOpen = false;
        }),

      openSaveSessionModal: () =>
        set((s) => {
          s.isSaveSessionModalOpen = true;
        }),
      closeSaveSessionModal: () =>
        set((s) => {
          s.isSaveSessionModalOpen = false;
        }),

      openQuickOpen: () =>
        set((s) => {
          s.isQuickOpenOpen = true;
        }),
      closeQuickOpen: () =>
        set((s) => {
          s.isQuickOpenOpen = false;
        }),

      openEditorPrompt: (prompt) =>
        set((s) => {
          s.editorPrompt = prompt;
        }),
      closeEditorPrompt: () =>
        set((s) => {
          s.editorPrompt = null;
        }),

      openWhatsNew: () =>
        set((s) => {
          s.isWhatsNewOpen = true;
        }),
      closeWhatsNew: () =>
        set((s) => {
          s.isWhatsNewOpen = false;
        }),

      setMainView: (view) =>
        set((s) => {
          s.mainView = view;
        }),

      openTaskEditor: (projectPath, taskId = null) =>
        set((s) => {
          s.taskEditor = { projectPath, taskId };
        }),
      closeTaskEditor: () =>
        set((s) => {
          s.taskEditor = null;
        }),

      openGitDialog: (kind) =>
        set((s) => {
          s.gitDialog = kind;
        }),
      closeGitDialog: () =>
        set((s) => {
          s.gitDialog = null;
        }),

      openSettings: (section) =>
        set((s) => {
          s.isSettingsOpen = true;
          if (section) s.settingsSection = section;
        }),
      closeSettings: () =>
        set((s) => {
          s.isSettingsOpen = false;
        }),
      toggleSettings: (section) =>
        set((s) => {
          // Asking for a section that is already showing means "close"; asking
          // for a different one while open means "switch to it".
          if (s.isSettingsOpen && (!section || section === s.settingsSection)) {
            s.isSettingsOpen = false;
            return;
          }
          s.isSettingsOpen = true;
          if (section) s.settingsSection = section;
        }),
      setSettingsSection: (section) =>
        set((s) => {
          s.settingsSection = section;
        }),

      pushModal: (modal) =>
        set((s) => {
          s.modalStack.push(modal);
        }),
      popModal: () =>
        set((s) => {
          s.modalStack.pop();
        }),
      clearModals: () =>
        set((s) => {
          s.modalStack.length = 0;
        }),
    })),
    { name: "ui" },
  ),
);

// Selectors --------------------------------------------------------------

export const useFocusedTerminalId = () =>
  useUIStore((s) => s.focusedTerminalId);

export const useHighlightedTerminalId = () =>
  useUIStore((s) => s.highlightedTerminalId);

export const useMaximizedTerminalId = () =>
  useUIStore((s) => s.maximizedTerminalId);

export const useIsWorkspaceModalOpen = () =>
  useUIStore((s) => s.isWorkspaceModalOpen);

export const useIsSaveSessionModalOpen = () =>
  useUIStore((s) => s.isSaveSessionModalOpen);

export const useIsQuickOpenOpen = () => useUIStore((s) => s.isQuickOpenOpen);

export const useEditorPrompt = (): EditorPrompt | null =>
  useUIStore((s) => s.editorPrompt);
export const useIsWhatsNewOpen = () => useUIStore((s) => s.isWhatsNewOpen);

export const useIsSettingsOpen = () => useUIStore((s) => s.isSettingsOpen);

export const useMainView = (): MainView => useUIStore((s) => s.mainView);

export const useTaskEditor = (): TaskEditorTarget | null =>
  useUIStore((s) => s.taskEditor);

export const useGitDialog = (): GitDialogKind | null =>
  useUIStore((s) => s.gitDialog);

export const useSettingsSection = () => useUIStore((s) => s.settingsSection);

export const useTopModal = (): ModalKind | null =>
  useUIStore((s) =>
    s.modalStack.length > 0 ? s.modalStack[s.modalStack.length - 1]! : null,
  );

/** Is something modal holding the window right now?
 *
 *  Settings covers the dock and each modal covers the window; every one of
 *  them owns its own Escape, and nothing else should fire underneath. The
 *  scrim stops the mouse but not the keyboard, so a document-level chord that
 *  keeps firing acts on a pane the user cannot see and did not aim at — ⌘W
 *  closing a hidden terminal is the shape that bug takes.
 *
 *  One derived answer rather than a list of flags at each call site, because
 *  the list is what went wrong: the Save session prompt was added to the
 *  workspace chords' guard and missed in the pane chords', so ⌘W killed a pane
 *  behind it. A modal added here is covered everywhere; a modal added to a
 *  boolean expression somewhere is covered there. */
function blockingModalOpen(s: UIState): boolean {
  return (
    s.isSettingsOpen ||
    s.isWorkspaceModalOpen ||
    s.isSaveSessionModalOpen ||
    s.isQuickOpenOpen ||
    s.taskEditor !== null ||
    s.gitDialog !== null ||
    s.editorPrompt !== null ||
    s.isCommandPaletteOpen ||
    s.isWhatsNewOpen
  );
}

/** Imperative form, for the document-level keydown handlers (they read the
 *  store from inside the handler rather than subscribing).
 *
 *  The confirm dialog is asked about separately because it does not live here:
 *  it carries a promise resolver, which has no business in a state tree, so it
 *  has a store of its own. It is still a modal that covers the window, so the
 *  one predicate every chord asks has to include it — the alternative is the
 *  list-of-flags-per-call-site that `blockingModalOpen` exists to replace. */
export const isAnyBlockingModalOpen = (): boolean =>
  blockingModalOpen(useUIStore.getState()) || isConfirmOpen();

/** Should a chord that acts on a PANE stand down right now?
 *
 *  Everything above, plus the main view. RocPlan takes the dock's place rather
 *  than covering it, and the dock stays MOUNTED behind `hidden` so no terminal
 *  loses a byte — which means the pane chords went on firing at panes that were
 *  not on screen. ⌘W closed one while the user was reading the board, and an
 *  idle pane does not even get the confirmation a running one would.
 *
 *  The same bug as the modal one, one surface further out: a keyboard that
 *  keeps acting on what the scrim — or here, the swap — has taken away. So it
 *  is the same predicate extended rather than a second boolean at the call
 *  site, and the next surface that takes the dock's place is covered by adding
 *  itself to `MainView` instead of by remembering this file exists. */
export const arePaneChordsBlocked = (): boolean =>
  isAnyBlockingModalOpen() || useUIStore.getState().mainView !== "terminals";
