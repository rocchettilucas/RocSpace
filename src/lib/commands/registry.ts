/** The command registry — one list of everything the app can be asked to do.
 *
 *  A palette is only as good as the actions it can reach, and the way that goes
 *  wrong is a central switch statement that every area has to remember to edit.
 *  So the registry is a MAILBOX rather than a table: each area hands in the
 *  actions it owns (`registerCommands`) and takes them back when it unmounts,
 *  and the palette asks for whatever is in the box right now (`allCommands`).
 *  An area that is not mounted contributes nothing, which is exactly what should
 *  happen to "Commit staged changes" when there is no git panel in the build.
 *
 *  Deliberately not a store. Nothing renders the registry — the palette reads it
 *  once, when it opens — so a subscription would buy re-renders nobody wants,
 *  and the actions themselves are closures over stores that are already
 *  reactive. `enabled()` is what keeps a stale entry off the list: it is asked
 *  at open time, not at registration time.
 *
 *  Registration order is the tie-break, but it is not the display order: the
 *  palette groups by `group` in `COMMAND_GROUPS` order, so two areas racing to
 *  mount cannot reshuffle the list a user is learning. */

/** Which section of the palette an action belongs under.
 *
 *  A closed union rather than a free string: a typo'd group would silently sort
 *  an action into a heading of its own, and the palette renders headings from
 *  `COMMAND_GROUPS` — a group that is not in that list would not render at all. */
export type CommandGroup =
  | "Workspace"
  | "Panes"
  | "Git"
  | "Editor"
  | "RocPlan"
  | "RocMind"
  | "Roc"
  | "Settings"
  | "Voice";

/** Display order of the palette's headings. The order of the union above, made
 *  iterable — the palette walks this rather than the results, so an empty group
 *  simply does not appear. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  "Workspace",
  "Panes",
  "Git",
  "Editor",
  "RocPlan",
  "RocMind",
  "Roc",
  "Settings",
  "Voice",
];

export interface CommandAction {
  /** Stable and kebab-cased (`"git.commit"`, `"editor.save"`). Stable because
   *  it is the identity a re-registration replaces, and because it is what a
   *  future "recently used" list would remember. */
  id: string;
  /** What the palette shows, phrased as the thing it will do. */
  title: string;
  group: CommandGroup;
  /** Extra words the fuzzy filter matches on — synonyms, and the vocabulary the
   *  user has rather than the one the UI has ("cwd" for "directory"). */
  keywords?: string[];
  /** Display only — the chord that already does this, e.g. `"⌘S"`. The palette
   *  never binds it; the area that owns the chord does. */
  shortcut?: string;
  /** Asked once, when the palette opens. False hides the action rather than
   *  disabling it: a palette is a search box, and a result you cannot pick is
   *  noise in a list you are filtering. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

/** Live registrations, in the order they were handed in. An array of arrays
 *  rather than a flat list so an unregister is one splice and cannot take
 *  somebody else's action with it. */
const registrations: CommandAction[][] = [];

/** Hand in a set of actions. The returned function takes them back out, and is
 *  safe to call twice (React 19 StrictMode double-invokes effect cleanups). */
export function registerCommands(actions: CommandAction[]): () => void {
  // Copied so a caller that mutates the array it passed — a builder that reuses
  // one buffer across renders — cannot rewrite what the palette will show.
  const own = [...actions];
  registrations.push(own);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = registrations.indexOf(own);
    if (at >= 0) registrations.splice(at, 1);
  };
}

/** Everything registered right now, de-duplicated by id.
 *
 *  Last registration of an id wins, at the position the id was FIRST seen. Both
 *  halves matter and they pull in opposite directions: React's StrictMode (and
 *  any re-register on a dependency change) briefly has two registrations for
 *  the same id live at once, and the fresher closure is the one that reads
 *  today's state — while the position is what the user's muscle memory is
 *  built on, so it must not jump when a re-registration happens to land while
 *  the palette is open. A `Map` gives exactly that: keys keep first-insertion
 *  order, values are overwritten in place. */
export function allCommands(): CommandAction[] {
  const byId = new Map<string, CommandAction>();
  for (const group of registrations) {
    for (const action of group) byId.set(action.id, action);
  }
  return [...byId.values()];
}

/** Drop every registration. Tests only — the app never wants this, because the
 *  areas that registered are still mounted and would not re-register. */
export function resetCommandRegistry(): void {
  registrations.length = 0;
}
