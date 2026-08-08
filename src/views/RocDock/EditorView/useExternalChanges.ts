/** Notice when the file on screen changed underneath the editor.
 *
 *  This app runs agents in the panes next to the editor, so "somebody else
 *  edited this file" is not the rare case it is in a normal editor — it is
 *  Tuesday. There is no watcher for it on purpose: `fs_browse` emits nothing,
 *  and the moment worth checking is the one where the user comes back to the
 *  window, not every write an agent makes while they are looking elsewhere.
 *
 *  What happens next depends on one question — is there unsaved work?
 *
 *   - **No.** The baseline is replaced and the editor shows the new file. There
 *     is nothing to ask about: the user has not written anything that the disk
 *     would be overwriting.
 *   - **Yes.** Nothing is decided here. The disk content is stashed and the
 *     user is asked, because both answers are ones only they can give — and
 *     silently taking either is how an editor loses an afternoon's work.
 *
 *  The ACTIVE tab only. Every open tab would mean up to a dozen reads per focus
 *  and, worse, a queue of dialogs about files the user cannot see. A background
 *  tab is checked the moment it is switched to (the effect re-runs on `path`).
 */

import { useEffect } from "react";
import {
  cachedFile,
  putFile,
  readFromDisk,
  stashExternal,
} from "@/lib/fileContents";
import {
  useActiveEditorPath,
  useActiveWorkspace,
  useEditorStore,
  useUIStore,
} from "@/stores";

export function useExternalChanges(): void {
  const projectRoot = useActiveWorkspace()?.projectPath ?? null;
  const path = useActiveEditorPath();

  useEffect(() => {
    if (!projectRoot || !path) return;
    let cancelled = false;

    const check = async () => {
      // A dialog is already up. Asking a second question over the first would
      // replace it, and the answer to the first would go unrecorded.
      if (useUIStore.getState().editorPrompt !== null) return;
      // Nothing read yet: the load is what will read it, and comparing against
      // a baseline we do not have would call every file changed.
      if (!cachedFile(path)) return;

      let fresh;
      try {
        fresh = await readFromDisk(projectRoot, path);
      } catch {
        // Deleted, moved, or turned into something unreadable. Leave the buffer
        // exactly as it is: it may be the only copy left, and a dialog offering
        // to take a file that is not there is no offer at all.
        return;
      }
      if (cancelled) return;

      // Re-read the baseline AFTER the await — a save may have landed while the
      // read was in flight, in which case there is nothing to reconcile.
      const baseline = cachedFile(path);
      if (!baseline || baseline.content === fresh.content) return;

      const mine = useEditorStore.getState().dirtyByPath[path];
      if (mine === undefined || mine === fresh.content) {
        // Clean, or dirty in exactly the way the disk already is. Adopt the new
        // baseline; `setBuffer` clears a flag that no longer describes
        // anything.
        putFile(path, fresh);
        if (mine !== undefined) {
          useEditorStore.getState().setBuffer(path, mine, fresh.content);
        }
        return;
      }

      stashExternal(path, fresh);
      useUIStore.getState().openEditorPrompt({ type: "external-change", path });
    };

    const onFocus = () => void check();
    // Once now as well as on every focus: switching back to a tab that has been
    // sitting open is the same question as switching back to the window.
    onFocus();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [projectRoot, path]);
}
