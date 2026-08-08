/** Registry of live xterm instances, keyed by terminal id.
 *
 *  xterm is imperative: once a Terminal is constructed, the only way to change
 *  its theme (or font size, scrollback, …) is to reach into `term.options` on
 *  the instance. React state can't do that, so `useXterm` registers every live
 *  terminal here and cross-cutting concerns iterate the registry:
 *    • theme switches (Phase 0B) — re-paint every open pane;
 *    • terminal settings (Phase 0C) — font size / scrollback;
 *    • Roc's live terminal view (Phase 4).
 *
 *  Entries MUST be removed on unmount, otherwise disposed terminals leak. */

import type { Terminal } from "@xterm/xterm";

const terminals = new Map<string, Terminal>();

/** Told whenever the SET of live terminals changes.
 *
 *  For readers that are not the pane holding the terminal. Roc's live view is
 *  the first: it shows whichever session the rail has focused, and that session
 *  may not have a mounted card yet — it belongs to another workspace, or the
 *  dock is still building the one it does belong to. Without a signal, the view
 *  would have to poll, or guess at effect ordering between two subtrees of the
 *  shell that are only siblings by accident of layout. */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to registrations and unregistrations. Returns the unsubscribe. */
export function onTerminalRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerTerminal(id: string, term: Terminal): void {
  if (terminals.get(id) === term) return;
  terminals.set(id, term);
  announce();
}

export function unregisterTerminal(id: string): void {
  if (!terminals.delete(id)) return;
  announce();
}

export function getTerminal(id: string): Terminal | undefined {
  return terminals.get(id);
}

/** Iterate a snapshot of the registry, so callbacks may register/unregister. */
export function forEachTerminal(
  fn: (id: string, term: Terminal) => void,
): void {
  for (const [id, term] of [...terminals]) fn(id, term);
}

/** Test helper — drop every entry, and every listener with it. A suite that
 *  left one behind would be called about the next suite's terminals. */
export function clearTerminalRegistry(): void {
  terminals.clear();
  listeners.clear();
}
