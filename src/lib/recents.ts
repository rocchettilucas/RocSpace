/** Recently opened project directories — what the new-workspace modal offers
 *  instead of making the user find the same folder again.
 *
 *  Its own module rather than part of `persistence.ts` so the workspaces store
 *  can record a directory the moment a workspace is created without importing
 *  the module that imports it. Persistence owns the list's *durability*: it
 *  seeds it on load, writes it into the snapshot, and subscribes here to know
 *  when to schedule a save.
 *
 *  Module state rather than a Zustand store: two writers (a workspace was
 *  created, the user removed a row) and one reader, so a subscription per
 *  component would buy nothing. */

import type { RecentProject } from "@/lib/bindings";

/** How many directories the modal offers. Enough to cover a week of projects,
 *  short enough that the list stays scannable. */
export const MAX_RECENTS = 10;

let recents: RecentProject[] = [];
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Newest first. */
export function getRecents(): readonly RecentProject[] {
  return recents;
}

/** Called on every change — persistence uses it to schedule a save. Returns an
 *  unsubscribe. */
export function onRecentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the list wholesale (hydration). Does NOT announce: the snapshot it
 *  came from is by definition already saved. */
export function seedRecents(next: readonly RecentProject[]): void {
  recents = [...next];
}

/** Record (or refresh) a directory. No-op for the cwd-less workspace. */
export function rememberRecent(path: string | null): void {
  if (!path) return;
  recents = [
    { path, lastOpenedAt: Date.now() },
    ...recents.filter((r) => r.path !== path),
  ].slice(0, MAX_RECENTS);
  announce();
}

export function forgetRecent(path: string): void {
  const next = recents.filter((r) => r.path !== path);
  if (next.length === recents.length) return;
  recents = next;
  announce();
}

/** Coerce whatever a snapshot holds into a list: strings only, no duplicate
 *  paths, newest first, capped. */
export function sanitizeRecents(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, lastOpenedAt } = entry as Partial<RecentProject>;
    if (typeof path !== "string" || path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      lastOpenedAt: typeof lastOpenedAt === "number" ? lastOpenedAt : 0,
    });
  }
  out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return out.slice(0, MAX_RECENTS);
}

/** Whether a path still exists. The seam the load-time prune goes through, so
 *  a test can answer without a filesystem. */
export type PathExists = (path: string) => Promise<boolean>;

/** Drop remembered directories that have since been moved or deleted. Offering
 *  a dead path is worse than forgetting it: the workspace it creates spawns
 *  every pane into nothing. */
export async function pruneRecents(pathExists: PathExists): Promise<void> {
  const checking = recents;
  if (checking.length === 0) return;

  // What the prune decides is which *paths* are dead, never what the list is:
  // it awaits one IPC round trip per directory, off the critical path at boot,
  // and a workspace created in that window is the normal case. Assigning back a
  // list filtered from the pre-await snapshot silently un-remembers whatever
  // landed meanwhile — and un-forgets whatever the user removed.
  const dead = new Set<string>();
  await Promise.all(
    checking.map(async (r) => {
      if (!(await pathExists(r.path))) dead.add(r.path);
    }),
  );
  if (dead.size === 0) return;

  const next = recents.filter((r) => !dead.has(r.path));
  if (next.length === recents.length) return;
  recents = next;
  announce();
}
