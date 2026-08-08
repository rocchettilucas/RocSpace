/** The mirror: memories written by agents in this app's panes, appearing
 *  without a reload.
 *
 *  "Mirror" is what the owner asked for, and watching is how it is achieved —
 *  never copying. Claude Code writes `~/.claude/projects/<slug>/memory`, and a
 *  RocSpace-owned duplicate of those files would disagree with the truth within
 *  a day. So this holds a Rust watch on every scope an open workspace could
 *  write to, and a `rocmind://changed` event re-reads THAT scope only.
 *
 *  "Could write to" is three things, and the second is the one that is easy to
 *  miss: the project's own scope, the scopes of its git WORKTREES (an agent
 *  running in one writes there, and Claude Code files it separately), and the
 *  slug a project with no memories yet will use for its first — otherwise the
 *  very first memory in a project is the one memory that needs a reload.
 *
 *  Mounted from the shell rather than from `MindView`, because the whole point
 *  is that the user is looking at their panes when this happens. The view
 *  watches what it is showing on top of this; both sides are reference-counted,
 *  so neither can hand back the other's watch. */

import { useEffect, useRef } from "react";
import { scopeSlugsForProject } from "@/lib/mindTree";
import {
  onMindScopeChanged,
  useMindScopes,
  useRocMindStore,
  useSettingsStore,
  useToastsStore,
  useUIStore,
  useWorkspaces,
} from "@/stores";

/** Is the app's sound-and-notification master mute on?
 *
 *  THE SEAM FOR PART B. That switch is Part B's to add (Settings →
 *  Notifications, "mute everything"), and it is on another branch — so this
 *  reads it defensively and treats "no such setting" as "not muted". When Part
 *  B lands, the mute starts covering this toast with no change here.
 *
 *  Written as a lookup rather than an import of a constant so that it cannot
 *  fail to compile against either version of the settings store. */
function notificationsMuted(): boolean {
  const settings = useSettingsStore.getState() as {
    notifications?: { muted?: boolean };
  };
  return settings.notifications?.muted === true;
}

export function useMindMirror(): void {
  const workspaces = useWorkspaces();
  const scopes = useMindScopes();
  const loadScopes = useRocMindStore((s) => s.loadScopes);
  const watchScope = useRocMindStore((s) => s.watchScope);
  const unwatchScope = useRocMindStore((s) => s.unwatchScope);
  const loadScope = useRocMindStore((s) => s.loadScope);

  // The scope list is what maps a workspace's directory to the slugs it owns,
  // so it has to be read before anything can be watched. Once, at startup: the
  // change handler re-reads it whenever a watched scope moves.
  useEffect(() => {
    void loadScopes();
  }, [loadScopes]);

  /** Slugs currently held BY THIS HOOK, so the effect below can hand back
   *  exactly what it took when the workspace list changes. A ref rather than
   *  state because nothing renders it and writing it must not re-run the
   *  effect that wrote it. */
  const held = useRef<string[]>([]);

  useEffect(() => {
    const wanted = new Set<string>();
    for (const workspace of workspaces) {
      if (!workspace.projectPath) continue;
      for (const slug of scopeSlugsForProject(scopes, workspace.projectPath)) {
        wanted.add(slug);
      }
    }

    const previous = held.current;
    const next = [...wanted];
    // Diffed rather than dropped-and-retaken: unwatching and re-watching the
    // same scope on every workspace change would re-seed its baseline, and a
    // memory written inside that window would never be announced.
    for (const slug of next) {
      if (previous.includes(slug)) continue;
      void watchScope(slug);
      // Read it once on the way in, so the mirror has a "before" to compare
      // the first change against — and so RocMind opens on a corpus that is
      // already there rather than one that fills in.
      void loadScope(slug);
    }
    for (const slug of previous) {
      if (!wanted.has(slug)) unwatchScope(slug);
    }
    held.current = next;
  }, [workspaces, scopes, watchScope, unwatchScope, loadScope]);

  // Hand everything back when the app tears down. Separate from the effect
  // above so it does not run on every workspace change.
  useEffect(
    () => () => {
      for (const slug of held.current) unwatchScope(slug);
      held.current = [];
    },
    [unwatchScope],
  );

  // The toast. Reports only memories that APPEARED — an agent editing one it
  // already wrote is the common case and is not news — and only while RocMind
  // is not the view you are looking at, because a tree that just grew a row is
  // its own notification.
  useEffect(
    () =>
      onMindScopeChanged(({ scope, added }) => {
        if (added.length === 0) return;
        if (useUIStore.getState().mainView === "rocmind") return;
        if (notificationsMuted()) return;

        const state = useRocMindStore.getState();
        const project =
          state.scopes.find((s) => s.slug === scope)?.label ?? "a project";
        const first = added[0]!;
        const message =
          added.length === 1
            ? `Memory written in ${project}: ${first.name}`
            : `${added.length} memories written in ${project}`;
        useToastsStore.getState().push({
          message,
          action: {
            label: "Read it",
            run: () => {
              useUIStore.getState().setMainView("rocmind");
              void useRocMindStore.getState().openMemory(first.path);
            },
          },
        });
      }),
    [],
  );
}
