/** Every soft cap in RocSpace, in one place.
 *
 *  These used to be per-module constants that drifted apart — the launch
 *  wizard let you create 12 terminals while the sidebar refused to add a 7th,
 *  so a wizard-built workspace could start over its own limit. Import from
 *  here; never re-declare a cap locally. */
export const LIMITS = {
  /** Terminal sessions per workspace.
   *  Was 12 (wizard) vs 6 (sidebar) — unified, and sized for the grid revamp.
   *  Phase 2 rescoped it from the profile to the workspace, which is the same
   *  thing it always measured: how many panes one dock holds. */
  terminalsPerWorkspace: 16,
  /** Open tabs in the editor pane. */
  editorTabs: 12,
  /** Retained notifications (newest first; older ones are dropped). */
  notifications: 50,
  /** Toasts on screen at once. Small on purpose: they are transient and they
   *  overlap the app, so a taller stack is a taller thing in the way. */
  toasts: 3,
  /** Retained output lines per terminal in the renderer's ring buffer.
   *  ~40 screens of scrollback at typical terminal density. */
  outputRingLines: 2000,
} as const;
