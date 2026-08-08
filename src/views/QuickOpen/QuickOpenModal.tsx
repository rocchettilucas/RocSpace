/** ⌘P — open a file by typing part of its name.
 *
 *  The file tree is fine for browsing and hopeless for finding: the editor sits
 *  in a narrow side panel, and reaching `src/views/RocDock/EditorView/…` is
 *  five clicks and a scroll. This is the other half.
 *
 *  Keyboard first, and the whole dialog IS the field — which is why Escape is
 *  handled on the input rather than left to `ModalShell`'s document handler
 *  (which stands down for text entry, correctly, for dialogs that have more
 *  than one answer in them). The same reasoning as the Save session prompt. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cachedFileIndex,
  refreshFileIndex,
  type FileIndex,
  type IndexedFile,
} from "@/lib/fileIndex";
import { cn } from "@/lib/utils";
import {
  useActiveWorkspace,
  useEditorStore,
  useIsQuickOpenOpen,
  useUIStore,
} from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";
import { rankFiles, type RankedFile } from "@/views/QuickOpen/rankFiles";

export function QuickOpenModal() {
  const isOpen = useIsQuickOpenOpen();
  if (!isOpen) return null;
  return <QuickOpenDialog />;
}

/** Exported for tests; app code renders `QuickOpenModal`. Mounted only while
 *  open, so the query starts empty every time. */
export function QuickOpenDialog() {
  const close = useUIStore((s) => s.closeQuickOpen);
  const root = useActiveWorkspace()?.projectPath ?? null;
  const openFile = useEditorStore((s) => s.openFile);
  const setRightDockMode = useEditorStore((s) => s.setRightDockMode);
  const setRightPanelCollapsed = useEditorStore(
    (s) => s.setRightPanelCollapsed,
  );

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<FileIndex>(
    () =>
      (root ? cachedFileIndex(root) : null) ?? { files: [], truncated: false },
  );
  // Only true while there is nothing to show yet. A refresh over a cached list
  // is invisible on purpose: the list is there, it is a moment out of date, and
  // a spinner over it would be a worse answer than the stale rows.
  const [walking, setWalking] = useState(
    () => root !== null && cachedFileIndex(root) === null,
  );
  // Only the ROOT read's failure gets here — a directory further down is
  // skipped by the walk. It is kept apart from an empty list because they are
  // different sentences: one says the project has no files in it, the other
  // says nobody could look.
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    refreshFileIndex(root)
      .then((next) => {
        if (cancelled) return;
        setIndex(next);
        setError(null);
        setWalking(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(typeof err === "string" ? err : String(err));
        setWalking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const results = useMemo(
    () => rankFiles(index.files, query),
    [index.files, query],
  );
  // Clamped rather than reset by an effect: the list changes on every
  // keystroke, and an effect that fixed the selection afterwards would render
  // one frame pointing at a row that is not there.
  const active =
    results.length === 0 ? 0 : Math.min(selected, results.length - 1);

  const choose = (file: IndexedFile | undefined) => {
    if (!file) return;
    openFile(file.path);
    // Open the file where the user can see it. Picking one from a finder is an
    // unambiguous request to look at it, and the panel is collapsed often
    // enough — it is the terminals' own toggle — that landing on a hidden tab
    // would read as the chord having done nothing.
    setRightDockMode("editor");
    setRightPanelCollapsed(false);
    close();
  };

  return (
    <ModalShell
      title="Go to file"
      onClose={close}
      initialFocusRef={inputRef}
      width="w-[560px]"
    >
      <div className="flex min-h-0 flex-col gap-2">
        <input
          ref={inputRef}
          value={query}
          placeholder="Type part of a file name…"
          autoComplete="off"
          spellCheck={false}
          aria-label="File name"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[active]?.file);
            }
          }}
          className={cn(
            "rounded-input border border-border bg-surface-0 px-2.5 py-1.5",
            "text-xs text-fg-primary outline-none focus:border-border-active",
          )}
        />

        {root === null ? (
          <p className="py-6 text-center text-[11px] text-fg-muted">
            This workspace has no project directory to search.
          </p>
        ) : error !== null ? (
          <p className="whitespace-pre-wrap py-6 text-center text-[11px] text-status-error">
            {error}
          </p>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-fg-muted">
            {walking
              ? "Reading the project…"
              : query.trim() === ""
                ? "No files found in this project."
                : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          <ul
            role="listbox"
            aria-label="Files"
            className="max-h-[320px] min-h-0 overflow-y-auto"
          >
            {results.map((result, i) => (
              <FileRow
                key={result.file.path}
                result={result}
                isActive={i === active}
                onPick={() => choose(result.file)}
              />
            ))}
          </ul>
        )}

        <p className="text-[11px] leading-relaxed text-fg-muted">
          ↑ ↓ to move, Enter to open, Esc to close. {SKIPPED_NOTE}
          {/* A cap nobody is told about is worse than a smaller cap: the
              finder's answer for a file past it is `Nothing matches “…”`,
              which reads as "there is no such file". */}
          {index.truncated ? ` ${TRUNCATED_NOTE}` : ""}
        </p>
      </div>
    </ModalShell>
  );
}

const SKIPPED_NOTE =
  "Build directories (.git, node_modules, target, dist) are not searched.";

const TRUNCATED_NOTE =
  "This project is larger than the finder walks, so some files are missing from this list.";

function FileRow({
  result,
  isActive,
  onPick,
}: {
  result: RankedFile;
  isActive: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    // `scrollIntoView` is missing in jsdom, and this is presentation — a list
    // that cannot scroll a row into view still opens the right file.
    if (isActive) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);

  return (
    <li ref={ref} role="option" aria-selected={isActive}>
      <button
        type="button"
        onClick={onPick}
        title={result.file.path}
        className={cn(
          "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs",
          isActive ? "bg-surface-2 text-fg-primary" : "hover:bg-surface-2",
        )}
      >
        <span className="truncate font-mono text-[11px] text-fg-secondary">
          <Highlighted text={result.file.rel} positions={result.positions} />
        </span>
      </button>
    </li>
  );
}

/** The matched letters, in the accent. Cheap orientation: it says WHY this row
 *  is in the list, which is most of what makes a fuzzy finder feel predictable
 *  rather than magic. */
function Highlighted({
  text,
  positions,
}: {
  text: string;
  positions: number[];
}) {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  const parts: React.ReactNode[] = [];
  let run = "";
  let runIsMatch = marked.has(0);
  for (let i = 0; i < text.length; i++) {
    const isMatch = marked.has(i);
    if (isMatch !== runIsMatch) {
      parts.push(
        runIsMatch ? (
          <span key={i} className="font-semibold text-accent">
            {run}
          </span>
        ) : (
          run
        ),
      );
      run = "";
      runIsMatch = isMatch;
    }
    run += text[i];
  }
  parts.push(
    runIsMatch ? (
      <span key="tail" className="font-semibold text-accent">
        {run}
      </span>
    ) : (
      run
    ),
  );
  return <>{parts}</>;
}
