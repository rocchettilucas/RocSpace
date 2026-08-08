/** The two questions the editor asks about a file, on one shell.
 *
 *  Both are the same disagreement seen from two sides — a buffer that is not
 *  what is on disk — and both have answers the app is not entitled to pick.
 *  Closing a tab with unsaved work and reconciling an edit that arrived from
 *  outside are exactly the moments where guessing costs somebody their work.
 *
 *  Mounted beside the shell rather than inside the editor panel, because
 *  neither question needs the panel to be open to arise: ⌘S works from a
 *  collapsed panel, and an agent in the pane next door can change a file the
 *  user is not currently looking at. */

import { useEffect, useRef } from "react";
import { clearExternal, peekExternal, putFile } from "@/lib/fileContents";
import { cn } from "@/lib/utils";
import { useEditorPrompt, useEditorStore, useUIStore } from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function EditorPrompts() {
  const prompt = useEditorPrompt();
  if (!prompt) return null;
  return prompt.type === "unsaved-close" ? (
    <UnsavedCloseDialog path={prompt.path} />
  ) : (
    <ExternalChangeDialog path={prompt.path} />
  );
}

const PRIMARY =
  "rounded-input bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90";
const QUIET =
  "rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary";

/** Exported for tests; app code renders `EditorPrompts`. */
export function UnsavedCloseDialog({ path }: { path: string }) {
  const close = useUIStore((s) => s.closeEditorPrompt);
  const closeTab = useEditorStore((s) => s.closeTab);
  const save = useEditorStore((s) => s.save);
  const saveRef = useRef<HTMLButtonElement | null>(null);

  const handleSave = async () => {
    // Only close the tab once the bytes are on disk. A failed write that took
    // the tab with it would throw the buffer away and report the failure in a
    // toast, which is the worst of both answers — the save button says "save",
    // and the file it names is still open when it could not.
    if (await save(path)) {
      closeTab(path);
      close();
    }
  };

  return (
    <ModalShell
      title="Unsaved changes"
      onClose={close}
      initialFocusRef={saveRef}
      width="w-[440px]"
      footer={
        <>
          <button type="button" onClick={close} className={QUIET}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              closeTab(path);
              close();
            }}
            className={cn(QUIET, "text-warning hover:text-warning")}
          >
            Discard
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={() => void handleSave()}
            className={PRIMARY}
          >
            Save and close
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-fg-secondary">
        <span className="font-medium text-fg-primary">{basename(path)}</span>{" "}
        has changes that are not on disk. Closing the tab discards them.
      </p>
      <p className="font-mono text-[11px] leading-relaxed text-fg-muted">
        {path}
      </p>
    </ModalShell>
  );
}

/** Exported for tests; app code renders `EditorPrompts`. */
export function ExternalChangeDialog({ path }: { path: string }) {
  const close = useUIStore((s) => s.closeEditorPrompt);
  const setBuffer = useEditorStore((s) => s.setBuffer);
  const revert = useEditorStore((s) => s.revert);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const disk = peekExternal(path);

  // Nothing stashed means the question has already been answered (or the stash
  // was cleared by a tab closing). Nothing to ask — take the dialog down.
  useEffect(() => {
    if (!disk) close();
  }, [disk, close]);
  if (!disk) return null;

  /** Both answers adopt the disk content as the BASELINE — the file on disk is
   *  what it is, and pretending otherwise means asking this same question again
   *  on the next focus. They differ only in what happens to the buffer. */
  const settle = (keepMine: boolean) => {
    const mine = useEditorStore.getState().dirtyByPath[path];
    putFile(path, disk);
    if (keepMine && mine !== undefined) setBuffer(path, mine, disk.content);
    else revert(path);
    clearExternal(path);
    close();
  };

  return (
    <ModalShell
      title="Changed on disk"
      onClose={close}
      initialFocusRef={keepRef}
      width="w-[460px]"
      footer={
        <>
          <button type="button" onClick={() => settle(false)} className={QUIET}>
            Take theirs
          </button>
          <button
            ref={keepRef}
            type="button"
            onClick={() => settle(true)}
            className={PRIMARY}
          >
            Keep mine
          </button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-fg-secondary">
        <span className="font-medium text-fg-primary">{basename(path)}</span>{" "}
        changed on disk while you had unsaved changes here — an agent in one of
        the panes, or another editor.
      </p>
      <p className="text-xs leading-relaxed text-fg-secondary">
        <span className="font-medium text-fg-primary">Keep mine</span> leaves
        your version in the editor; saving it overwrites what is on disk.{" "}
        <span className="font-medium text-fg-primary">Take theirs</span> loads
        the file from disk and discards what you typed.
      </p>
      <p className="font-mono text-[11px] leading-relaxed text-fg-muted">
        {path}
      </p>
    </ModalShell>
  );
}
