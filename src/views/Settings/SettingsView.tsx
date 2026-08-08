import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { isTextEntry } from "@/lib/dom";
import { useUIStore } from "@/stores";
import type { SettingsSectionId } from "@/stores/ui";
import { SettingsNav } from "@/views/Settings/SettingsNav";
import { AboutSection } from "@/views/Settings/sections/AboutSection";
import { AgentsSection } from "@/views/Settings/sections/AgentsSection";
import { AppearanceSection } from "@/views/Settings/sections/AppearanceSection";
import { HistorySection } from "@/views/Settings/sections/HistorySection";
import { NotificationsSection } from "@/views/Settings/sections/NotificationsSection";
import { ShortcutsSection } from "@/views/Settings/sections/ShortcutsSection";
import { TerminalSection } from "@/views/Settings/sections/TerminalSection";
import { VoiceSection } from "@/views/Settings/sections/VoiceSection";
import { isAnyDialogOpen } from "@/views/Workspaces/ModalShell";

/** Settings.
 *
 *  A full-area overlay inside the RocDock column rather than a modal: the
 *  sidebar and right panel stay usable, and — because the dock stays mounted
 *  underneath — terminals keep streaming while you change a setting and you see
 *  the result the moment you close it. Escape or the topbar gear dismisses. */
export function SettingsOverlay() {
  const isOpen = useUIStore((s) => s.isSettingsOpen);
  if (!isOpen) return null;
  return <SettingsView />;
}

/** Exported for tests; app code renders `SettingsOverlay`. */
export function SettingsView() {
  const section = useUIStore((s) => s.settingsSection);
  const setSection = useUIStore((s) => s.setSettingsSection);
  const closeSettings = useUIStore((s) => s.closeSettings);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Opening Settings replaced the whole dock but left focus wherever it was,
  // which broke two things at once. A focused terminal keeps the keyboard, so
  // Escape reached xterm first and went down the PTY as \x1b instead of closing
  // the overlay; and a screen reader stayed parked outside a dialog that had
  // just taken over the view, with nothing announcing it.
  //
  // So: move focus to the close button on open, and hand it back to whatever
  // had it when we close. `aria-modal` stays false and no focus trap goes in —
  // the sidebar is *meant* to stay usable — this is a focus move, not a trap.
  useEffect(() => {
    const previous = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      // Skip if it left the DOM meanwhile (its terminal was closed, its
      // popover dismissed) — focusing a detached node just drops focus to the
      // body, which is worse than leaving it be.
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  // Escape closes. Bound on the document (not the overlay) so it works no
  // matter where focus sits — including the sidebar, which stays interactive.
  //
  // Deliberately does NOT stop propagation: the sidebar's popovers listen for
  // Escape too, and swallowing it here would close Settings while leaving a
  // popover stranded on screen. Closing both is the less surprising outcome
  // for those — they are chrome the overlay sits beside, not over.
  //
  // A DIALOG is the case that is not. Settings › History asks "delete this
  // saved session?" from inside the overlay, so the confirmation is on top of
  // it, and one Escape used to answer "no" and tear Settings down with it —
  // the user loses their place for having declined. `ModalShell` has ordered
  // its own stack since Phase 5 (`isTopmost`); this asks the same queue the
  // one question an outsider can ask it: is anything above me.
  //
  // A focused text field is the other exception. There Escape already means
  // "back out of what I am typing" — it is exactly how the rename inputs in the
  // sidebar work — so taking the whole overlay down mid-edit, from under the
  // Default model field, is not what anyone pressed it for. The first press
  // steps out of the field; with focus off the input, a second one closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isAnyDialogOpen()) return;
      const active = document.activeElement;
      if (isTextEntry(active)) {
        // Only blur fields we own: the sidebar's rename inputs run their own
        // Escape handling (and commit on blur), so reaching into them here
        // would turn a cancel into a save.
        if (dialogRef.current?.contains(active)) active.blur();
        return;
      }
      closeSettings();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeSettings]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal={false}
      aria-label="Settings"
      className="absolute inset-0 z-10 flex flex-col bg-surface-0"
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Settings
        </span>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={closeSettings}
          title="Close settings (Esc)"
          aria-label="Close settings"
          className="flex h-6 w-6 items-center justify-center rounded-input text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <SettingsNav active={section} onSelect={setSection} />
        {/* `key` remounts the pane on a section switch so each section starts
            at the top of its own scroll instead of inheriting the last one's
            offset. */}
        <div key={section} className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <SectionContent section={section} />
        </div>
      </div>
    </div>
  );
}

function SectionContent({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "appearance":
      return <AppearanceSection />;
    case "terminal":
      return <TerminalSection />;
    case "agents":
      return <AgentsSection />;
    case "notifications":
      return <NotificationsSection />;
    case "voice":
      return <VoiceSection />;
    case "shortcuts":
      return <ShortcutsSection />;
    case "history":
      return <HistorySection />;
    case "about":
      return <AboutSection />;
  }
}
