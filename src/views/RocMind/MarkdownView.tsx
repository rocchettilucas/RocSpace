/** A parsed memory, as React elements.
 *
 *  Every node comes from `lib/markdown`'s tree; nothing here takes a string and
 *  makes DOM out of it. That is the whole security argument for the pane: the
 *  text is written by agents and full of shell, HTML and URLs, and React's own
 *  escaping is the only thing standing between that and the window — so no
 *  `dangerouslySetInnerHTML`, anywhere, ever.
 *
 *  `[[wikilinks]]` render as chips that select the linked memory. Ordinary
 *  links do NOT navigate: this is a webview with the whole app in it, and a
 *  memory that says `[here](https://…)` must not be able to replace the
 *  application with a web page. They are shown with their href as a title so
 *  the address is readable, and left inert. */

import type { Block, Inline, ListItem } from "@/lib/markdown";
import { cn } from "@/lib/utils";

export interface MarkdownViewProps {
  blocks: Block[];
  /** What a `[[wikilink]]` does. */
  onOpenLink: (target: string) => void;
  /** Whether a wikilink target resolves to a memory that exists. An unresolved
   *  link is still drawn — the corpus is somebody else's, and a dangling link
   *  is information — but it is not offered as a button. */
  resolves: (target: string) => boolean;
}

export function MarkdownView({
  blocks,
  onOpenLink,
  resolves,
}: MarkdownViewProps) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-fg-secondary">
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          onOpenLink={onOpenLink}
          resolves={resolves}
        />
      ))}
    </div>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold text-fg-primary",
  2: "text-sm font-semibold text-fg-primary",
  3: "text-sm font-semibold text-fg-primary",
  4: "text-xs font-semibold uppercase tracking-wide text-fg-secondary",
  5: "text-xs font-semibold uppercase tracking-wide text-fg-muted",
  6: "text-xs font-semibold uppercase tracking-wide text-fg-muted",
};

function BlockView({
  block,
  onOpenLink,
  resolves,
}: {
  block: Block;
} & Pick<MarkdownViewProps, "onOpenLink" | "resolves">) {
  const inline = (nodes: Inline[]) => (
    <InlineView nodes={nodes} onOpenLink={onOpenLink} resolves={resolves} />
  );

  switch (block.type) {
    case "heading": {
      // The tag is chosen from the level so the pane has a real document
      // outline for a screen reader, rather than six sizes of <div>.
      const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
      return (
        <Tag className={cn("mt-2 first:mt-0", HEADING_CLASS[block.level])}>
          {inline(block.children)}
        </Tag>
      );
    }
    case "paragraph":
      return <p className="whitespace-pre-wrap">{inline(block.children)}</p>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 text-xs text-fg-primary">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-fg-muted">
          {inline(block.children)}
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "list":
      return (
        <ul className="flex flex-col gap-1">
          {block.items.map((item: ListItem, index: number) => (
            <li
              key={index}
              className="flex gap-2"
              // Indentation is data (how deep the bullet was written), not a
              // class we can enumerate — a memory can nest four deep.
              style={{ paddingLeft: `${item.depth * 14}px` }}
            >
              <span className="shrink-0 select-none text-fg-muted">
                {block.ordered ? `${index + 1}.` : "•"}
              </span>
              <span className="min-w-0 flex-1">{inline(item.children)}</span>
            </li>
          ))}
        </ul>
      );
  }
}

function InlineView({
  nodes,
  onOpenLink,
  resolves,
}: {
  nodes: Inline[];
} & Pick<MarkdownViewProps, "onOpenLink" | "resolves">) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <span key={index}>{node.text}</span>;
          case "code":
            return (
              <code
                key={index}
                className="rounded bg-surface-2 px-1 py-0.5 text-xs text-fg-primary"
              >
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold text-fg-primary">
                <InlineView
                  nodes={node.children}
                  onOpenLink={onOpenLink}
                  resolves={resolves}
                />
              </strong>
            );
          case "em":
            return (
              <em key={index} className="italic">
                <InlineView
                  nodes={node.children}
                  onOpenLink={onOpenLink}
                  resolves={resolves}
                />
              </em>
            );
          case "link":
            return (
              <span
                key={index}
                title={node.href}
                className="text-fg-primary underline decoration-border underline-offset-2"
              >
                <InlineView
                  nodes={node.children}
                  onOpenLink={onOpenLink}
                  resolves={resolves}
                />
              </span>
            );
          case "wikilink":
            return (
              <WikiLink
                key={index}
                target={node.target}
                onOpenLink={onOpenLink}
                resolves={resolves(node.target)}
              />
            );
        }
      })}
    </>
  );
}

/** One `[[target]]`, inline.
 *
 *  A button when it resolves, plain text when it does not — because a control
 *  that looks pressable and does nothing is worse than a label. */
export function WikiLink({
  target,
  onOpenLink,
  resolves,
}: {
  target: string;
  onOpenLink: (target: string) => void;
  resolves: boolean;
}) {
  if (!resolves) {
    return (
      <span
        title="No memory of this name is loaded"
        className="rounded bg-surface-2 px-1 py-0.5 text-xs text-fg-muted line-through decoration-fg-muted/60"
      >
        {target}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenLink(target)}
      className="rounded bg-accent-soft px-1 py-0.5 text-xs text-accent hover:bg-accent-soft hover:underline"
    >
      {target}
    </button>
  );
}
