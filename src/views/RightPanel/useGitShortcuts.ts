/** ⌘⇧K — open the Git panel with the commit message box focused.
 *
 *  One chord for three store writes, because the useful version of "take me to
 *  the commit box" has to make the box exist first: the right panel may be
 *  collapsed, and it may be showing the inspector. Expanding, switching mode
 *  and asking for focus are one action from where the user is standing.
 *
 *  ⌘K goes to the command palette and ⌘⇧S is the session save, so the letter is
 *  what was left that means "commit" — it is git's own ⌘⇧K in more than one
 *  editor, which is the point.
 *
 *  Capture phase and `preventDefault`, like every other global chord here: a
 *  focused terminal owns the keyboard through xterm's hidden textarea, and an
 *  unclaimed chord goes down the PTY. NOT gated on `mainView` — the right panel
 *  is a sibling of the dock, so it is on screen whether the middle column is
 *  showing terminals, the board or Roc. */

import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import { isAnyBlockingModalOpen, useEditorStore, useGitStore } from "@/stores";

export function useGitShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "k") return;
      if (isAnyBlockingModalOpen()) return;
      // A real text field keeps it — including the commit box itself, where the
      // chord would be asking for something it already has.
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      const editor = useEditorStore.getState();
      editor.setRightPanelCollapsed(false);
      editor.setRightDockMode("git");
      useGitStore.getState().focusCommitBox();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
