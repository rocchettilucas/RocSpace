/** ⌘⇧S — "Save session as…".
 *
 *  One field. It opens on the workspace's own name, which is the answer most of
 *  the time, and it opens with that name selected so typing over it is one
 *  gesture. Enter saves, Escape cancels.
 *
 *  The name is a filename in the making: Rust slugs it to `[a-z0-9-]`, and two
 *  names that slug the same are the same file. So the dialog says which file it
 *  will be, and asks before writing over one that already exists — a save that
 *  silently replaced another session would be the kind of data loss the user
 *  only discovers when they go looking for it.
 *
 *  Which is why the save waits for the list rather than the render: the
 *  collision comes off an async `session_list`, and ⌘⇧S + Enter is faster than
 *  a filesystem round trip. */

import { useEffect, useRef, useState } from "react";
import { sessionSlug } from "@/lib/savedSessions";
import { cn } from "@/lib/utils";
import {
  confirmAction,
  useActiveWorkspace,
  useSavedSessionsStore,
  useUIStore,
} from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";

export function SaveSessionModal() {
  const isOpen = useUIStore((s) => s.isSaveSessionModalOpen);
  if (!isOpen) return null;
  return <SaveSessionDialog />;
}

/** Exported for tests; app code renders `SaveSessionModal`. Mounted only while
 *  open, so the draft name starts fresh each time. */
export function SaveSessionDialog() {
  const close = useUIStore((s) => s.closeSaveSessionModal);
  const workspace = useActiveWorkspace();
  const saveActiveWorkspace = useSavedSessionsStore(
    (s) => s.saveActiveWorkspace,
  );
  const refresh = useSavedSessionsStore((s) => s.refresh);
  const sessions = useSavedSessionsStore((s) => s.sessions);

  const [name, setName] = useState(workspace?.name ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The list read on open, as a promise. A save waits for it before deciding
   *  whether it is overwriting anything — see `handleSave`. */
  const listed = useRef<Promise<void> | null>(null);

  // Refresh the list on open: the collision question below is only as good as
  // how recently we asked, and another window (or another save) may have
  // written since this app last looked.
  useEffect(() => {
    listed.current = refresh();
  }, [refresh]);

  const slug = sessionSlug(name);
  const collision = sessions.find((s) => sessionSlug(s.name) === slug) ?? null;
  const canSave = slug !== "" && workspace !== null && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    // Marked as saving before the await: this is a modal opened by a chord and
    // confirmed by Enter, so the whole window between the two is one keystroke
    // wide, and a second Enter must not start a second save.
    setSaving(true);
    // A list we have not received yet cannot say "this name is taken". ⌘⇧S
    // followed straight by Enter used to cross exactly that gap: `sessions`
    // was still `[]`, no confirmation was asked, and the save replaced a file
    // on disk silently. The reactive `collision` above is what the button
    // says; this is what the save decides on, and it is read after the list
    // lands rather than from the render that started before it.
    await listed.current;
    const taken =
      useSavedSessionsStore
        .getState()
        .sessions.find((s) => sessionSlug(s.name) === slug) ?? null;
    if (taken) {
      const ok = await confirmAction({
        title: "Replace saved session",
        message: `“${taken.name}” is already saved under this name. Replace it?`,
        detail: `Both names become ${slug}.json, so the session already on disk is overwritten.`,
        confirmLabel: "Replace it",
        tone: "danger",
      });
      if (!ok) {
        setSaving(false);
        return;
      }
    }
    const meta = await saveActiveWorkspace(name);
    // Only close on success: a failed save that took the dialog with it would
    // leave the user believing their session is on disk.
    if (meta) close();
    else setSaving(false);
  };

  return (
    <ModalShell
      title="Save session as…"
      onClose={close}
      initialFocusRef={inputRef}
      width="w-[420px]"
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
            disabled={!canSave}
            onClick={() => void handleSave()}
            className={cn(
              "rounded-input px-3.5 py-1.5 text-xs font-medium",
              canSave
                ? "bg-accent text-accent-fg hover:opacity-90"
                : "cursor-not-allowed bg-surface-2 text-fg-muted",
            )}
          >
            {collision ? "Replace" : "Save session"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label
          htmlFor="save-session-name"
          className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted"
        >
          Name
        </label>
        <input
          id="save-session-name"
          ref={inputRef}
          value={name}
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // The dialog IS this field, so its Escape and the dialog's are the
            // same gesture — which is why the shell's document handler stands
            // down for text fields and this one answers instead.
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Enter") {
              e.preventDefault();
              void handleSave();
            }
          }}
          className={cn(
            "rounded-input border border-border bg-surface-0 px-2.5 py-1.5",
            "text-xs text-fg-primary outline-none focus:border-border-active",
          )}
        />
        {workspace === null ? (
          <p className="text-[11px] leading-relaxed text-fg-muted">
            There is no workspace open to save.
          </p>
        ) : slug === "" ? (
          <p className="text-[11px] leading-relaxed text-warning">
            A name needs at least one letter or digit — it becomes the
            file&apos;s name on disk.
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-fg-muted">
            Saves {workspace.name} as{" "}
            <span className="font-mono text-fg-secondary">{slug}.json</span>
            {collision ? " — replacing the session already saved there." : "."}
          </p>
        )}
      </div>
    </ModalShell>
  );
}
