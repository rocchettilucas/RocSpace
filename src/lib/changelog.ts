/** `CHANGELOG.md`, read by the app.
 *
 *  The "What's new" dialog is fed by the same file a reader on GitHub sees,
 *  which is the only arrangement that cannot drift: there is no second copy to
 *  forget to update, and an entry that is not in the changelog is not announced.
 *  Vite inlines the markdown at build time (`?raw`), so this costs one string in
 *  the bundle and no I/O at runtime.
 *
 *  # The format it expects
 *
 *      ## [phase-5] Git, Editor & Finish — 2026-08-05
 *      ### Added
 *      - one thing that changed
 *
 *  The bracketed id is the entry's identity, and it is what settings remembers
 *  as "already read". An id rather than the title so that fixing a typo in a
 *  heading does not re-announce a release the user has seen — and so the
 *  acknowledgement survives the day this file switches from phases to version
 *  numbers.
 *
 *  Parsing is deliberately forgiving in one direction only: anything that is not
 *  a recognized heading or a `- ` bullet is IGNORED rather than guessed at. The
 *  file's job is to be readable as markdown first; the dialog takes what it can
 *  recognize and nothing here can throw. */

import raw from "../../CHANGELOG.md?raw";

export interface ChangelogSection {
  /** "Added", "Changed", "Fixed" — whatever the `###` says. */
  heading: string;
  items: string[];
}

export interface ChangelogEntry {
  /** The bracketed id: `phase-5`, `0.1.0`. */
  id: string;
  /** What follows the id, minus the date: `Git, Editor & Finish`. May be "". */
  title: string;
  /** ISO date, or `null` when the heading carried none. */
  date: string | null;
  sections: ChangelogSection[];
  /** Bullets that appeared under the entry before any `###` — an entry written
   *  as plain prose (`0.1.0`) has neither, and reads out of `lead` instead. */
  lead: string[];
}

/** `## [id] Title — 2026-08-05`, with the title and the date both optional.
 *  Accepts an em dash or a hyphen before the date, because both get typed. */
const ENTRY = /^##\s+\[([^\]]+)\]\s*(.*)$/;
const SECTION = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.+?)\s*$/;
const TRAILING_DATE = /\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** A bullet's continuation: an indented line that is not itself a bullet. */
const CONTINUATION = /^\s+(\S.*)$/;

/** Strip the markdown a one-line bullet realistically carries. Not a markdown
 *  parser: bold, code spans and links become their text, because the dialog
 *  renders plain strings and a stray `**` reads as a mistake. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;

  for (const line of markdown.split("\n")) {
    const heading = ENTRY.exec(line);
    if (heading) {
      const rest = heading[2] ?? "";
      const dated = TRAILING_DATE.exec(rest);
      entry = {
        id: heading[1]!.trim(),
        title: plain(dated ? rest.slice(0, dated.index) : rest),
        date: dated?.[1] ?? null,
        sections: [],
        lead: [],
      };
      section = null;
      entries.push(entry);
      continue;
    }
    if (!entry) continue;

    const sectionHeading = SECTION.exec(line);
    if (sectionHeading) {
      section = { heading: plain(sectionHeading[1]!), items: [] };
      entry.sections.push(section);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      (section?.items ?? entry.lead).push(plain(bullet[1]!));
      continue;
    }

    // A wrapped bullet. Only ever appended to something that already exists,
    // so indented prose under no bullet at all is dropped rather than becoming
    // an item of its own.
    const wrapped = CONTINUATION.exec(line);
    if (wrapped) {
      const items = section?.items ?? entry.lead;
      const last = items.length - 1;
      if (last >= 0) items[last] = `${items[last]} ${plain(wrapped[1]!)}`;
    }
  }

  return entries;
}

/** Every entry, newest first — the order the file is written in. */
export const CHANGELOG_ENTRIES: readonly ChangelogEntry[] = parseChangelog(raw);

/** The entry "What's new" announces. `null` only if the file lost its headings,
 *  in which case the dialog stays shut rather than showing an empty box. */
export const LATEST_ENTRY: ChangelogEntry | null = CHANGELOG_ENTRIES[0] ?? null;
