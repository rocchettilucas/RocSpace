/** The right half: one memory, read.
 *
 *  Its `description` as a subtitle and its `metadata.type` as a chip, because
 *  both were written to be read that way — the description is a one-line
 *  summary built for ranking, and the type is the corpus's own vocabulary
 *  (`user`, `feedback`, `project`, `reference`).
 *
 *  Then the body as markdown, then the graph this memory sits in, from both
 *  directions: the `[[links]]` it makes, and the memories that link back to it.
 *  Backlinks are computed rather than stored — the links are already in every
 *  header, and an index would be a second thing to keep in step with a
 *  directory Claude Code is writing. */

import { ArrowUpRight, CornerDownLeft, FileText, X } from "lucide-react";
import { useMemo } from "react";
import { parseMarkdown, stripFrontmatter } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import {
  useMindBacklinks,
  useMindBody,
  useMindSelected,
  useRocMindStore,
} from "@/stores";
import { MarkdownView } from "@/views/RocMind/MarkdownView";
import type { MindMemory } from "@/lib/bindings";

export function MemoryPane() {
  const memory = useMindSelected();
  const body = useMindBody(memory?.path ?? null);
  const bodyLoading = useRocMindStore((s) => s.bodyLoading);
  const openMemoryByName = useRocMindStore((s) => s.openMemoryByName);
  const openMemory = useRocMindStore((s) => s.openMemory);
  const closeMemory = useRocMindStore((s) => s.closeMemory);
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  const backlinks = useMindBacklinks(memory);

  /** Parse once per body, not once per render: a memory is a few kilobytes and
   *  the pane re-renders on every store write (including the live mirror's). */
  const blocks = useMemo(
    () => (body === undefined ? [] : parseMarkdown(stripFrontmatter(body))),
    [body],
  );

  /** Does `[[target]]` point at a memory we have? Scoped to the memory's own
   *  project first — the same rule `openMemoryByName` follows — but falling
   *  back to anything loaded, because a link across scopes is still a link. */
  const resolves = useMemo(() => {
    const names = new Set<string>();
    for (const memories of Object.values(byScope)) {
      for (const item of memories) names.add(item.name.toLowerCase());
    }
    return (target: string) => names.has(target.trim().toLowerCase());
  }, [byScope]);

  if (!memory) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="flex max-w-md flex-col gap-2 text-center">
          <FileText
            className="mx-auto h-6 w-6 text-fg-muted"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg-primary">Pick a memory</p>
          <p className="text-xs leading-relaxed text-fg-muted">
            Open a project on the left. Everything your agents chose to remember
            about it is in there — and every memory carries the links it made to
            the others.
          </p>
        </div>
      </div>
    );
  }

  return (
    <article className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-col gap-2 border-b border-border px-5 py-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg-primary">
            {memory.name}
          </h2>
          {memory.memoryType ? (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-secondary">
              {memory.memoryType}
            </span>
          ) : null}
          {/* The way to put a memory down, and until now there was not one:
              `closeMemory` existed in the store with no call site anywhere. In
              the tree that left the pane showing the last thing clicked for
              ever; in the GRAPH it is worse, because the pane only appears
              once something is selected and then takes two fifths of the
              surface — so one node click permanently shrank the picture the
              tab exists to show. */}
          <button
            type="button"
            onClick={closeMemory}
            aria-label="Close this memory"
            title="Close this memory"
            className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {memory.description ? (
          <p className="text-xs leading-relaxed text-fg-secondary">
            {memory.description}
          </p>
        ) : null}
        <p className="truncate text-[10px] text-fg-muted" title={memory.path}>
          {memory.path}
        </p>
      </header>

      <div className="flex-1 px-5 py-4">
        {body === undefined ? (
          <p className="text-xs text-fg-muted">
            {bodyLoading ? "Reading…" : "This memory could not be read."}
          </p>
        ) : (
          <MarkdownView
            blocks={blocks}
            resolves={resolves}
            onOpenLink={(target) => {
              openMemoryByName(target, memory.scope);
            }}
          />
        )}
      </div>

      <footer className="flex flex-col gap-4 border-t border-border px-5 py-4">
        <LinkRow
          icon={<ArrowUpRight className="h-3 w-3" aria-hidden="true" />}
          title="Links to"
          empty="This memory does not link to another."
        >
          {memory.links.map((target) => (
            <button
              key={target}
              type="button"
              disabled={!resolves(target)}
              onClick={() => openMemoryByName(target, memory.scope)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px]",
                resolves(target)
                  ? "bg-accent-soft text-accent hover:underline"
                  : "cursor-not-allowed bg-surface-2 text-fg-muted line-through",
              )}
              title={
                resolves(target) ? target : "No memory of this name is loaded"
              }
            >
              {target}
            </button>
          ))}
        </LinkRow>

        <LinkRow
          icon={<CornerDownLeft className="h-3 w-3" aria-hidden="true" />}
          title="Linked from"
          empty="Nothing links here yet."
        >
          {backlinks.map((source: MindMemory) => (
            <button
              key={source.path}
              type="button"
              onClick={() => void openMemory(source.path)}
              title={source.description || source.name}
              className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
            >
              {source.name}
            </button>
          ))}
        </LinkRow>
      </footer>
    </article>
  );
}

function LinkRow({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fg-muted">
        {icon}
        {title}
      </h3>
      {children.length === 0 ? (
        <p className="text-[11px] text-fg-muted">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">{children}</div>
      )}
    </section>
  );
}
