import { useEffect, useState } from "react";
import { AppShell } from "@/views/AppShell";
import { ConfirmDialog } from "@/views/Workspaces/ConfirmDialog";
import { NewWorkspaceModal } from "@/views/Workspaces/NewWorkspaceModal";
import { SaveSessionModal } from "@/views/Workspaces/SaveSessionModal";
import { WhatsNewModal } from "@/views/Workspaces/WhatsNewModal";
import { WorkspaceEmptyState } from "@/views/Workspaces/WorkspaceEmptyState";
import { useWorkspaceShortcuts } from "@/views/Workspaces/useWorkspaceShortcuts";
import { useZoomShortcuts } from "@/hooks/useZoomShortcuts";
import { CommandPalette } from "@/views/CommandPalette/CommandPalette";
import { useCommandPaletteShortcut } from "@/views/CommandPalette/useCommandPaletteShortcut";
import { useWorkspacesStore } from "@/stores";
import { mountPtyBridge } from "@/lib/ptyBridge";
import { mountNotificationsBridge } from "@/lib/notificationsBridge";
import { unlockNotificationAudio } from "@/lib/notificationSound";
import { mountRocPlanDispatch } from "@/lib/rocplanDispatch";
import { reconcileHydratedTerminals, resumeTargetOf } from "@/lib/hydration";
import { loadSnapshot, startAutosave } from "@/lib/persistence";
import { spawnTerminal } from "@/lib/spawn";

export default function App() {
  // A boolean rather than the list: App re-rendering is a whole-tree re-render,
  // and the only thing here that cares is which of the two shells to show.
  const hasWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const [hydrating, setHydrating] = useState(true);

  // ⌘T / ⌘1-9 live here rather than in the shell so they work in the empty
  // state too — the chord the empty state tells the user to press has to be
  // bound by something the empty state is inside of.
  useWorkspaceShortcuts();

  // ⌘K, here for the same reason: the palette is how you get anywhere, and
  // "anywhere" has to include the state where there is nowhere yet — its New
  // workspace action is the way out of the empty state.
  useCommandPaletteShortcut();

  // ⌘+ / ⌘− / ⌘0. Also here, and for a blunter reason than the others: it is
  // the chord you reach for when you cannot read the screen, which includes
  // the screen that has nothing on it yet.
  useZoomShortcuts();

  // 1. Mount the PTY IPC bridge once (events → store dispatches), the
  //    notifications bridge (status transitions → notification pushes), and
  //    RocPlan's dispatch watcher (a dispatched pane finishing → its card moves
  //    to In Review). The last one lives up here rather than in the board
  //    because it has to keep working while the user is on their panes — which
  //    is exactly where they are once an agent has picked something up.
  // Open the audio device on the first thing the user does, because a webview
  // will not let a page make noise until they have done something — and the
  // moment a notification wants a sound is never that moment. Capture phase and
  // `once`, on both a click and a key, so it costs one listener that removes
  // itself and cannot be swallowed by anything calling `stopPropagation`.
  useEffect(() => {
    const unlock = () => unlockNotificationAudio();
    const opts = { capture: true, once: true } as const;
    window.addEventListener("pointerdown", unlock, opts);
    window.addEventListener("keydown", unlock, opts);
    return () => {
      window.removeEventListener("pointerdown", unlock, opts);
      window.removeEventListener("keydown", unlock, opts);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const unsubscribeNotifications = mountNotificationsBridge();
    const unsubscribeDispatch = mountRocPlanDispatch();
    mountPtyBridge()
      .then((un) => {
        unlisten = un;
      })
      .catch((err) => console.warn("ptyBridge failed to mount:", err));
    return () => {
      unlisten?.();
      unsubscribeNotifications();
      unsubscribeDispatch();
    };
  }, []);

  // 2. Load persisted snapshot on startup, then enable autosave.
  //    If a snapshot was found, also restart any agent streams that were
  //    "running" before the last quit so the user picks up where they left off.
  useEffect(() => {
    let stopAutosave: (() => void) | undefined;
    (async () => {
      const restored = await loadSnapshot();
      stopAutosave = startAutosave();
      setHydrating(false);
      if (restored) {
        // Nothing the snapshot says about live processes is true any more, so
        // the pids go before the UI can act on them, and the conversations
        // that are worth offering are parked as offers (which is also what
        // keeps ptyBridge from mistaking one for a running process).
        const toRespawn = reconcileHydratedTerminals();
        // Defer terminal spawns past the AppShell mount commit. Starting PTYs
        // before mount causes Tauri output events to arrive while panels are
        // still mounting, which trips React 19's useSyncExternalStore
        // consistency check.
        setTimeout(() => {
          for (const t of toRespawn) {
            // A pane that was mid-conversation when the app quit picks that
            // conversation back up — the uuid it was working under is on the
            // session `reconcileHydratedTerminals` handed back, and Rust turns
            // it into `--resume`. Everything else starts fresh, and the pid +
            // uuid land via `recordSpawn` either way.
            //
            // The loop asks for every pane at once on purpose: `spawnTerminal`
            // is bounded by `MAX_CONCURRENT_SPAWNS`, so a boot with sixteen
            // panes across four workspaces sends four spawn calls at a time
            // without the caller having to pace itself.
            void spawnTerminal(t, { resumeClaudeSession: resumeTargetOf(t) });
          }
        }, 100);
      }
    })();
    return () => {
      stopAutosave?.();
    };
  }, []);

  if (hydrating) return null;
  return (
    <>
      {hasWorkspaces ? <AppShell /> : <WorkspaceEmptyState />}
      {/* Mounted beside the gate, not inside the shell: ⌘T has to be able to
          open it from the empty state, which is the only place where there is
          nothing else to open it from. ⌘⇧S is claimed in the empty state too —
          it opens a dialog that says there is nothing to save, which is a
          better answer than the chord doing nothing at all. */}
      <NewWorkspaceModal />
      <SaveSessionModal />
      {/* Announces itself once per changelog entry, so it has to be mounted
          before there is anything to announce it over. */}
      <WhatsNewModal />
      {/* Beside them for the same reason, and one further: the palette also
          REGISTERS the built-in actions, so it has to be mounted whether or
          not it is open — and whether or not there is a workspace to act on.
          What is offered in the empty state is what `enabled()` allows. */}
      <CommandPalette />
      {/* Last, so it renders over whatever asked the question — a confirmation
          is always about the dialog above it, never underneath. */}
      <ConfirmDialog />
    </>
  );
}
