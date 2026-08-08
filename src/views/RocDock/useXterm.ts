import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Terminal,
  type IEvent,
  type ILink,
  type ITerminalAddon,
  type ITerminalOptions,
  type ITheme,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { commands } from "@/lib/bindings";
import { useEditorStore, useSettingsStore, useTerminalsStore } from "@/stores";
import { notifyTerminalUserInput } from "@/lib/ptyBridge";
import { onPaneAttachmentChange } from "@/lib/paneAttachment";
import { registerTerminal, unregisterTerminal } from "@/lib/terminalRegistry";
import { getTheme } from "@/themes/registry";
import { xtermThemeFor } from "@/themes/xterm";
import { findPaths, resolvePath } from "@/views/RocDock/terminalPathMatcher";

/** Terminal palette for the theme the user currently has selected — the same
 *  19 tokens that paint the chrome (see src/themes/xterm.ts). */
function currentXtermTheme(): ITheme {
  return xtermThemeFor(getTheme(useSettingsStore.getState().themeId));
}

const MIN_VISIBLE_TERMINAL_WIDTH = 40;
const MIN_VISIBLE_TERMINAL_HEIGHT = 18;
// Allow xterm to refit down to narrow panes — tested at ~20 cols, which is
// enough for the agent CLIs (claude / codex) to wrap their banner gracefully
// without leaving a frozen oversized grid behind. Previously this was 80×10,
// which kept the terminal at its prior larger size whenever the pane was
// narrow, leaving black gutters and stale text.
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;

export interface XtermHandle {
  write: (data: string) => void;
  clear: () => void;
  fit: () => void;
}

export function shouldMeasureTerminalElement(el: HTMLElement): boolean {
  return (
    el.clientWidth >= MIN_VISIBLE_TERMINAL_WIDTH &&
    el.clientHeight >= MIN_VISIBLE_TERMINAL_HEIGHT
  );
}

export function shouldFitTerminalDimensions(dims: {
  cols: number;
  rows: number;
}): boolean {
  return dims.cols >= MIN_TERMINAL_COLS && dims.rows >= MIN_TERMINAL_ROWS;
}

export function createTerminalOptions(): ITerminalOptions {
  // Settings the user owns (Settings › Terminal). Read at construction; the
  // subscription in `useXterm` keeps already-open terminals in sync.
  const { fontSize, scrollback } = useSettingsStore.getState().terminal;

  return {
    fontFamily:
      '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
    fontSize,
    // 1.2 lineHeight gives the glyph descent room inside the cell so the
    // cursor block aligns visually with the text baseline. With 1.0, agent
    // CLIs (claude / codex / opencode) render the prompt caret a hair high.
    lineHeight: 1.2,
    letterSpacing: 0,
    customGlyphs: true,
    cursorBlink: true,
    cursorStyle: "block",
    theme: currentXtermTheme(),
    convertEol: true,
    scrollback,
    allowTransparency: false,
    smoothScrollDuration: 100,
  };
}

// GPU rendering ------------------------------------------------------------

/** The slice of `WebglAddon` this module depends on, so a test can stand in
 *  for it without a GPU. */
export interface WebglRendererAddon extends ITerminalAddon {
  readonly onContextLoss: IEvent<void>;
}

/** Warn once per pane per failure mode, and no more.
 *
 *  Once per *app run* is what this used to be, and it hid the thing the warning
 *  is for: a machine where WebGL works everywhere but one pane, or where the
 *  GPU takes one context away, would report the first pane and then degrade
 *  the other fifteen in silence. Keyed by terminal id, a repeat is only ever a
 *  repeat — the same pane failing the same way, which is what a retry does. */
const warned = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...args);
}

/** Test helper — the warn-once state is module-global by design. */
export function resetRendererWarnings(): void {
  warned.clear();
}

/** Put `term` on the GPU renderer, falling back to xterm's DOM renderer when
 *  that is not possible. Returns a disposer (null when the addon never
 *  attached), safe to call more than once.
 *
 *  Both failure modes are real and neither is fatal:
 *   - activation throws where there is no WebGL2 context at all — a VM, a
 *     software rasterizer, a browser with it disabled, jsdom under test;
 *   - the context is lost *later* (driver reset, GPU switch on a laptop,
 *     waking from sleep). The addon keeps its canvas but paints nothing, so
 *     the pane silently goes blank unless it is dropped — disposing it hands
 *     rendering back to the DOM renderer, which is slower and correct.
 *
 *  Load AFTER `term.open()`: the addon needs the terminal's screen element.
 *
 *  The disposer is for taking a live terminal OFF the GPU. It is not for
 *  teardown: `Terminal.dispose()` disposes its own addons, and only that route
 *  reaches them with the terminal already marked disposed — which is what stops
 *  the addon building a replacement renderer nobody will ever see. */
export function attachWebglRenderer(
  terminalId: string,
  term: Pick<Terminal, "loadAddon">,
  createAddon: () => WebglRendererAddon = () => new WebglAddon(),
): (() => void) | null {
  let addon: WebglRendererAddon;
  try {
    addon = createAddon();
    term.loadAddon(addon);
  } catch (err) {
    warnOnce(
      `webgl-unavailable:${terminalId}`,
      `[xterm ${terminalId}] WebGL renderer unavailable, using the DOM renderer:`,
      err,
    );
    return null;
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      addon.dispose();
    } catch (err) {
      warnOnce(
        `webgl-dispose:${terminalId}`,
        `[xterm ${terminalId}] WebGL renderer dispose failed:`,
        err,
      );
    }
  };

  addon.onContextLoss(() => {
    warnOnce(
      `webgl-context-loss:${terminalId}`,
      `[xterm ${terminalId}] WebGL context lost, falling back to the DOM renderer.`,
    );
    dispose();
  });

  return dispose;
}

/** Mount an xterm.js Terminal into `containerRef.current` and wire it to a real
 *  PTY identified by `terminalId`:
 *   - keystrokes (term.onData) → terminal_write Tauri command
 *   - container resizes → terminal_resize Tauri command
 *   - live PTY output arrives from `outputQueue`'s frame loop, which resolves
 *     this instance through `terminalRegistry`: the bytes reach the terminal
 *     without passing through React, though the card still re-renders once per
 *     flush off the store append that goes with it.
 *     `handleRef.current.write` is left for the parent's one-shot replay of
 *     the ring buffer into a newly opened terminal. */
export function useXterm(terminalId: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<XtermHandle | null>(null);
  // Hold a stable copy so cleanup doesn't capture a stale id if the component
  // is reused across terminals. Writing a ref during render is a purity
  // violation, so the sync happens in an effect — but it must be a *layout*
  // effect: passive effects flush asynchronously after paint, while every
  // reader here is a native xterm/DOM callback that can fire in that gap and
  // would then address the previously-mounted terminal.
  const idRef = useRef(terminalId);
  useLayoutEffect(() => {
    idRef.current = terminalId;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal(createTerminalOptions());
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Publish the instance so cross-cutting concerns can reach it (theme
    // switches below, terminal settings in Phase 0C, Roc's live view later).
    // Key it to the id this instance mounted with: idRef tracks the latest
    // render, which can differ by the time cleanup runs.
    const registeredId = idRef.current;
    registerTerminal(registeredId, term);

    // The GPU renderer follows the host's attachment, not this effect's life.
    //
    // A card outlives its place on screen: maximizing one pane leaves the other
    // fifteen mounted with their hosts detached (see `paneAttachment`), and a
    // WebGL context on a detached canvas is still a context — WebKit allows a
    // small number of them per process and force-loses the oldest to make room,
    // permanently. So the addon is loaded when the pane is on screen and let go
    // when it is not, which also gives a pane that lost its context a way back
    // onto the GPU. Attaching needs `term.open()` to have run: the addon takes
    // the terminal's screen element.
    let disposeWebgl: (() => void) | null = null;
    const syncRenderer = () => {
      const onScreen = el.isConnected;
      if (onScreen && !disposeWebgl) {
        disposeWebgl = attachWebglRenderer(registeredId, term);
      } else if (!onScreen && disposeWebgl) {
        disposeWebgl();
        disposeWebgl = null;
      }
    };
    syncRenderer();
    const unsubscribeAttachment = onPaneAttachmentChange(
      registeredId,
      syncRenderer,
    );

    const fitIfVisible = () => {
      if (!shouldMeasureTerminalElement(el)) return;
      try {
        const dims = fitAddon.proposeDimensions();
        if (!dims || !shouldFitTerminalDimensions(dims)) return;
        fitAddon.fit();
      } catch {
        /* container hasn't sized yet; observer below catches it */
      }
    };

    // Coalesces refits (font-size changes here, container resizes below) into
    // one per frame. Cancelled on unmount.
    let rafId = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(fitIfVisible);
    };

    // xterm owns its own colors and geometry, so anything the user changes in
    // Settings has to be pushed into every open instance imperatively.
    const unsubscribeSettings = useSettingsStore.subscribe((state, prev) => {
      if (state.themeId !== prev.themeId) {
        term.options.theme = xtermThemeFor(getTheme(state.themeId));
      }
      if (state.terminal.fontSize !== prev.terminal.fontSize) {
        term.options.fontSize = state.terminal.fontSize;
        // The cell size just changed but the container did not, so the resize
        // observer will not fire: refit explicitly or the PTY keeps the old
        // cols/rows and output wraps against a grid that no longer exists.
        // Next frame, so xterm has re-measured the character size first.
        scheduleFit();
      }
      if (state.terminal.scrollback !== prev.terminal.scrollback) {
        term.options.scrollback = state.terminal.scrollback;
      }
    });

    // Pipe ALL outgoing data (keystrokes, paste, protocol responses) → PTY
    // stdin. onData fires for terminal protocol responses too (e.g. the agent
    // CLI's cursor-position / Primary DA query → xterm auto-replies), so we
    // forward without flipping the user-input gate here.
    const dataDisposable = term.onData((data) => {
      commands.terminalWrite(idRef.current, data).catch((err) => {
        console.warn(`[xterm ${idRef.current}] write failed:`, err);
      });
    });

    // Open the user-input gate ONLY on real keystrokes. Using onKey instead of
    // onData prevents terminal protocol auto-replies (which also flow through
    // onData on boot) from spuriously marking the terminal as "user has typed",
    // which would otherwise arm the idle watchdog and flip the brand-new pane
    // to "Awaiting" before the user has touched it.
    const keyDisposable = term.onKey(() => {
      notifyTerminalUserInput(idRef.current);
    });

    // Mirror xterm's reported size to the PTY so line wrapping / TUI apps work.
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      commands.terminalResize(idRef.current, cols, rows).catch(() => {
        /* ignore — PTY may not be spawned yet */
      });
    });

    // File-path link provider: underline `src/foo.ts:12` style tokens in
    // PTY output and, on click, switch the dock view to the editor and open
    // the file at the requested line. The matcher's regex is in
    // terminalPathMatcher.ts; resolution happens against the session's
    // projectPath (cwd) at click time so it stays fresh if the user moves
    // the terminal between projects.
    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const buf = term.buffer.active;
        const line = buf.getLine(bufferLineNumber - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const matches = findPaths(text);
        if (matches.length === 0) return callback(undefined);

        const links: ILink[] = matches.map((m) => ({
          range: {
            start: { x: m.start + 1, y: bufferLineNumber },
            end: { x: m.end, y: bufferLineNumber },
          },
          text: text.slice(m.start, m.end),
          decorations: { underline: true, pointerCursor: true },
          activate: () => {
            const session = useTerminalsStore.getState().byId[idRef.current];
            const cwd = session?.projectPath ?? "";
            const abs = resolvePath(m.pathText, cwd);
            if (!abs) return;
            const editor = useEditorStore.getState();
            editor.setRightDockMode("editor");
            editor.openFile(abs, m.line);
          },
        }));
        callback(links);
      },
    });

    // Initial fit (next tick so layout has settled). Fit triggers onResize.
    requestAnimationFrame(fitIfVisible);

    // Re-fit on container resize. Coalesced with rAF (see `scheduleFit`) to
    // avoid a fit storm during panel drags.
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);

    handleRef.current = {
      write: (data) => term.write(data),
      clear: () => term.clear(),
      fit: fitIfVisible,
    };

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      unsubscribeSettings();
      unsubscribeAttachment();
      unregisterTerminal(registeredId);
      dataDisposable.dispose();
      keyDisposable.dispose();
      resizeDisposable.dispose();
      linkProvider.dispose();
      handleRef.current = null;
      // `Terminal.dispose()` disposes the addons it loaded, and this is the one
      // path that must let it: xterm marks its own store disposed *before*
      // disposing its children, and that flag is the guard `addon-webgl` checks
      // before handing rendering back. Disposing the addon first misses the
      // guard, so closing a pane builds and resizes a DOM renderer for a
      // terminal that is about to stop existing. GPU resources go either way.
      term.dispose();
    };
  }, []);

  return { containerRef, handleRef };
}
