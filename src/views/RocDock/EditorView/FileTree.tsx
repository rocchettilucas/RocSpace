import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
} from "lucide-react";
import { commands, type DirEntryDto } from "@/lib/bindings";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores";

interface FileTreeProps {
  projectRoot: string;
}

/** Fetch result tagged with the root it belongs to, so a result for a previous
 *  root reads as "still loading" instead of needing an effect to clear it. */
interface RootResult {
  root: string;
  entries: DirEntryDto[] | null;
  error: string | null;
}

export function FileTree({ projectRoot }: FileTreeProps) {
  const [result, setResult] = useState<RootResult | null>(null);
  // Nothing here is watched and nothing expires: a file an agent wrote after
  // the tree was drawn had no way onto it at all, and the only escape was
  // switching the panel's mode away and back to remount the whole thing. This
  // is the ask, threaded through every read below.
  const [nonce, setNonce] = useState(0);
  // Matched on the root alone, deliberately not on the nonce: a refresh that
  // blanked this to "Loading…" would unmount every open row, and each of those
  // is where its own expansion lives. Collapsing the branch the user was
  // reading is a worse answer than one that is a moment old.
  const current = result?.root === projectRoot ? result : null;
  const entries = current?.entries ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    let cancelled = false;
    commands
      .fsReadDir(projectRoot, projectRoot)
      .then((res) => {
        if (cancelled) return;
        setResult({ root: projectRoot, entries: res, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          root: projectRoot,
          entries: null,
          error: typeof err === "string" ? err : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, nonce]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Files
        </span>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          title="Refresh the file tree"
          aria-label="Refresh the file tree"
          className="grid h-5 w-5 shrink-0 place-items-center rounded-input text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-xs text-fg-secondary">
        {error ? (
          <ErrorRow message={error} indent={0} />
        ) : entries === null ? (
          <LoadingRow indent={0} />
        ) : entries.length === 0 ? (
          // A directory with nothing in it renders nothing, which is
          // indistinguishable from a tree that failed to load — the panel is
          // blank either way, and the user is left waiting on a read that
          // already finished.
          <EmptyRow message="This directory is empty." indent={0} />
        ) : (
          entries.map((e) => (
            <EntryRow
              key={e.path}
              entry={e}
              projectRoot={projectRoot}
              depth={0}
              refreshNonce={nonce}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface EntryRowProps {
  entry: DirEntryDto;
  projectRoot: string;
  depth: number;
  /** Bumped by the header's refresh. Every listing below is tagged with the one
   *  it answers, so a bump invalidates the whole open branch at once. */
  refreshNonce: number;
}

function EntryRow({ entry, projectRoot, depth, refreshNonce }: EntryRowProps) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{
    nonce: number;
    items: DirEntryDto[];
  } | null>(null);
  const [failure, setFailure] = useState<{
    nonce: number;
    message: string;
  } | null>(null);
  const openFile = useEditorStore((s) => s.openFile);

  // The listing is drawn whichever refresh it came from — same reason the root
  // is: replacing an open branch with "Loading…" is a worse answer than a
  // listing that is a moment old. The error is NOT: it belongs to the attempt
  // that produced it, and a refresh is the user asking for a fresh verdict.
  const entries = listing?.items ?? null;
  const loadError = failure?.nonce === refreshNonce ? failure.message : null;

  useEffect(() => {
    // Re-read unless there is a SUCCESSFUL listing for the refresh in hand: a
    // collapse and re-expand is the user asking again, and an error is not an
    // answer worth keeping. (`failure` is deliberately not a dependency — it
    // would re-run this on its own result, forever.)
    if (!entry.isDir || !open || listing?.nonce === refreshNonce) return;
    let cancelled = false;
    commands
      .fsReadDir(projectRoot, entry.path)
      .then((res) => {
        if (cancelled) return;
        setListing({ nonce: refreshNonce, items: res });
        // The retry succeeding has to take the error row with it. Without
        // this the branch below — which checks the error first — drew the
        // failure over children that had already arrived.
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure({
          nonce: refreshNonce,
          message: typeof err === "string" ? err : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.isDir, entry.path, open, projectRoot, listing, refreshNonce]);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      setOpen((v) => !v);
    } else {
      openFile(entry.path);
    }
  }, [entry.isDir, entry.path, openFile]);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left",
          "hover:bg-surface-2",
          entry.hidden && "opacity-50",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={entry.path}
      >
        {entry.isDir ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-fg-muted" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {entry.isDir ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <File className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {entry.isDir && open ? (
        loadError ? (
          <ErrorRow message={loadError} indent={depth + 1} />
        ) : entries === null ? (
          <LoadingRow indent={depth + 1} />
        ) : entries.length === 0 ? (
          // Same reason as the root, one level in: an expanded folder that
          // draws nothing looks like one that is still loading forever.
          <EmptyRow message="Empty" indent={depth + 1} />
        ) : (
          entries.map((child) => (
            <EntryRow
              key={child.path}
              entry={child}
              projectRoot={projectRoot}
              depth={depth + 1}
              refreshNonce={refreshNonce}
            />
          ))
        )
      ) : null}
    </>
  );
}

function EmptyRow({ message, indent }: { message: string; indent: number }) {
  return (
    <div
      className="py-0.5 text-xs italic text-fg-muted"
      style={{ paddingLeft: `${indent * 12 + 16}px` }}
    >
      {message}
    </div>
  );
}

function LoadingRow({ indent }: { indent: number }) {
  return (
    <div
      className="py-0.5 text-xs italic text-fg-muted"
      style={{ paddingLeft: `${indent * 12 + 16}px` }}
    >
      Loading…
    </div>
  );
}

function ErrorRow({ message, indent }: { message: string; indent: number }) {
  return (
    <div
      className="py-0.5 text-xs text-status-error"
      style={{ paddingLeft: `${indent * 12 + 16}px` }}
      title={message}
    >
      {message}
    </div>
  );
}
