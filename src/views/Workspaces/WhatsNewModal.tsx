/** "What's new" — the top entry of `CHANGELOG.md`, shown once.
 *
 *  Once per ENTRY, not once per launch: settings remembers the id of the entry
 *  the user has read (`whatsNewSeen`), and the dialog announces itself when the
 *  top of the changelog is something else. Closing it IS the acknowledgement —
 *  there is no "don't show this again" checkbox, because the dialog already
 *  behaves that way, and a checkbox would only offer the user a way to lose the
 *  next one too.
 *
 *  It opens on a first launch as well. Deliberate for an app whose changelog is
 *  six phases of revamp: a fresh install is exactly the reader for whom "here
 *  is what this is" is worth one dialog. Reopening it later is a command-palette
 *  action and a button in Settings › About.
 *
 *  The announcement WAITS for the settings read. `main.tsx` starts it and
 *  renders the app after a 250 ms race, so the app is on screen while a slow
 *  read is still outstanding — and `whatsNewSeen` is `""` until it lands, which
 *  is indistinguishable from "never read it". A mount-only check would announce
 *  the release again to somebody who dismissed it yesterday, every launch,
 *  which is the one failure this dialog cannot have: it is modal, and its whole
 *  contract is once.
 *
 *  So it hangs off `hydrated`, which is set when the read settles whether it
 *  found a file or not. A read that never settles at all (a hung store plugin)
 *  therefore never announces — the safe direction for a dialog whose failure
 *  mode is nagging. */

import { useEffect } from "react";
import { LATEST_ENTRY } from "@/lib/changelog";
import { useSettingsHydrated, useSettingsStore, useUIStore } from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";
import type { ChangelogEntry } from "@/lib/changelog";

export function WhatsNewModal() {
  const isOpen = useUIStore((s) => s.isWhatsNewOpen);
  const hydrated = useSettingsHydrated();

  // Runs once, when the read lands. `hydrated` only ever goes false → true, so
  // this cannot fire twice; and the question it asks — "has this build's entry
  // been read" — cannot change afterwards except by this dialog closing, which
  // sets the very flag it would be asking about.
  useEffect(() => {
    if (!hydrated) return;
    if (!LATEST_ENTRY) return;
    if (useSettingsStore.getState().whatsNewSeen === LATEST_ENTRY.id) return;
    useUIStore.getState().openWhatsNew();
  }, [hydrated]);

  if (!isOpen || !LATEST_ENTRY) return null;
  return <WhatsNewDialog entry={LATEST_ENTRY} />;
}

/** Exported for tests; app code renders `WhatsNewModal`. */
export function WhatsNewDialog({ entry }: { entry: ChangelogEntry }) {
  const close = () => {
    useUIStore.getState().closeWhatsNew();
    // Marked read on close rather than on open: a dialog that was dismissed by
    // a stray Escape before it painted is still one the user did not read, and
    // Escape here at least means they saw something.
    useSettingsStore.getState().setWhatsNewSeen(entry.id);
  };

  return (
    <ModalShell
      title={entry.title ? `What's new — ${entry.title}` : "What's new"}
      onClose={close}
      width="w-[560px]"
      footer={
        <button
          type="button"
          onClick={close}
          className="rounded-input bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          Got it
        </button>
      }
    >
      {entry.date ? (
        <p className="-mb-2 text-[11px] text-fg-muted">{entry.date}</p>
      ) : null}

      {entry.lead.length > 0 ? <Items items={entry.lead} /> : null}

      {entry.sections.map((section) => (
        <div key={section.heading} className="flex flex-col gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            {section.heading}
          </h3>
          <Items items={section.items} />
        </div>
      ))}

      <p className="text-[11px] leading-relaxed text-fg-muted">
        Everything else is in CHANGELOG.md, and Settings › Shortcuts lists every
        key RocSpace binds.
      </p>
    </ModalShell>
  );
}

function Items({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex gap-2 text-xs leading-relaxed text-fg-secondary"
        >
          <span aria-hidden className="select-none text-accent">
            •
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
