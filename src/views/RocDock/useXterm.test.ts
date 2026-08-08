import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { DEFAULT_TERMINAL_SETTINGS, useSettingsStore } from "@/stores/settings";
import {
  attachWebglRenderer,
  createTerminalOptions,
  resetRendererWarnings,
  shouldFitTerminalDimensions,
  shouldMeasureTerminalElement,
  type WebglRendererAddon,
} from "@/views/RocDock/useXterm";

function elementWithSize(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: height,
  });
  return el;
}

describe("shouldMeasureTerminalElement", () => {
  it("does not measure hidden or zero-sized terminal hosts", () => {
    expect(shouldMeasureTerminalElement(elementWithSize(0, 120))).toBe(false);
    expect(shouldMeasureTerminalElement(elementWithSize(120, 0))).toBe(false);
  });

  it("measures once the host has visible space", () => {
    expect(shouldMeasureTerminalElement(elementWithSize(40, 18))).toBe(true);
  });
});

describe("shouldFitTerminalDimensions", () => {
  it("rejects fits below a tiny minimum so unrenderable grids are skipped", () => {
    expect(shouldFitTerminalDimensions({ cols: 19, rows: 24 })).toBe(false);
    expect(shouldFitTerminalDimensions({ cols: 20, rows: 4 })).toBe(false);
  });

  it("fits down to narrow panes so terminals reflow inside small grid cells", () => {
    // 20×5 must succeed: agent CLIs (claude / codex) wrap their banner cleanly
    // in narrow panes, and we don't want a stale oversized grid behind a
    // resized card.
    expect(shouldFitTerminalDimensions({ cols: 20, rows: 5 })).toBe(true);
    expect(shouldFitTerminalDimensions({ cols: 80, rows: 24 })).toBe(true);
  });
});

describe("createTerminalOptions", () => {
  afterEach(() => {
    useSettingsStore.setState({ terminal: { ...DEFAULT_TERMINAL_SETTINGS } });
  });

  it("uses contiguous terminal cell geometry so block-art logos stay joined", () => {
    const options = createTerminalOptions();

    // 1.2 line-height keeps glyph descenders inside the cell so the cursor
    // block aligns with the agent CLI prompt baseline. letterSpacing must
    // stay 0 and customGlyphs must stay on so block-art logos don't gap.
    expect(options.lineHeight).toBe(1.2);
    expect(options.letterSpacing).toBe(0);
    expect(options.customGlyphs).toBe(true);
  });

  it("takes font size and scrollback from the settings store", () => {
    expect(createTerminalOptions()).toMatchObject(DEFAULT_TERMINAL_SETTINGS);

    useSettingsStore.setState({ terminal: { fontSize: 17, scrollback: 1000 } });

    // A terminal opened after the user changed the setting must start there —
    // the live subscription only covers instances that already exist.
    expect(createTerminalOptions()).toMatchObject({
      fontSize: 17,
      scrollback: 1000,
    });
  });
});

/** The GPU renderer is an optimization, so every way it can fail has to end in
 *  a working pane on the DOM renderer rather than a blank one. */
describe("attachWebglRenderer", () => {
  /** A stand-in for `WebglAddon`: records disposal and lets a test fire the
   *  context-loss event the real GPU fires on a driver reset. */
  function fakeAddon() {
    let listener: (() => void) | null = null;
    const addon = {
      disposeCalls: 0,
      activate() {},
      dispose() {
        addon.disposeCalls++;
      },
      onContextLoss(handler: () => void) {
        listener = handler;
        return { dispose: () => {} };
      },
      loseContext() {
        listener?.();
      },
    };
    return addon;
  }

  const terminalThatAccepts = (loaded: unknown[]) =>
    ({ loadAddon: (addon: unknown) => loaded.push(addon) }) as Pick<
      Terminal,
      "loadAddon"
    >;

  beforeEach(() => {
    resetRendererWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the addon onto the terminal", () => {
    const loaded: unknown[] = [];
    const addon = fakeAddon();

    const dispose = attachWebglRenderer(
      "t1",
      terminalThatAccepts(loaded),
      () => addon as unknown as WebglRendererAddon,
    );

    expect(loaded).toEqual([addon]);
    expect(dispose).toBeTypeOf("function");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to the DOM renderer when activation throws", () => {
    // jsdom, a VM, a machine with WebGL disabled: `loadAddon` activates the
    // addon, which throws when there is no WebGL2 context to be had.
    const term = {
      loadAddon: () => {
        throw new Error("Could not get WebGL2 context");
      },
    } as unknown as Pick<Terminal, "loadAddon">;

    const dispose = attachWebglRenderer(
      "t1",
      term,
      () => fakeAddon() as unknown as WebglRendererAddon,
    );

    expect(dispose).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("survives an addon that throws on construction", () => {
    const dispose = attachWebglRenderer("t1", terminalThatAccepts([]), () => {
      throw new Error("no WebGL2");
    });

    expect(dispose).toBeNull();
  });

  it("names the pane it is warning about", () => {
    const term = {
      loadAddon: () => {
        throw new Error("nope");
      },
    } as unknown as Pick<Terminal, "loadAddon">;

    attachWebglRenderer(
      "term-42",
      term,
      () => fakeAddon() as unknown as WebglRendererAddon,
    );

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("term-42"),
      expect.anything(),
    );
  });

  it("warns once per pane, not once per app run", () => {
    // Keyed by app run, one pane's failure silenced the other fifteen — which
    // is exactly the case (a single degraded pane) the warning is for.
    const term = {
      loadAddon: () => {
        throw new Error("nope");
      },
    } as unknown as Pick<Terminal, "loadAddon">;
    const attach = (id: string) =>
      attachWebglRenderer(
        id,
        term,
        () => fakeAddon() as unknown as WebglRendererAddon,
      );

    for (let i = 0; i < 5; i++) attach(`term-${i}`);
    // The same pane retrying is a repeat, and stays quiet.
    attach("term-0");

    expect(console.warn).toHaveBeenCalledTimes(5);
  });

  it("drops the addon when the GPU takes the context away", () => {
    // The addon keeps its canvas but paints nothing after a context loss, so
    // a pane that keeps it goes silently blank.
    const addon = fakeAddon();
    attachWebglRenderer(
      "t1",
      terminalThatAccepts([]),
      () => addon as unknown as WebglRendererAddon,
    );

    addon.loseContext();

    expect(addon.disposeCalls).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("disposes exactly once across context loss and unmount", () => {
    const addon = fakeAddon();
    const dispose = attachWebglRenderer(
      "t1",
      terminalThatAccepts([]),
      () => addon as unknown as WebglRendererAddon,
    );

    addon.loseContext();
    dispose?.();
    dispose?.();

    expect(addon.disposeCalls).toBe(1);
  });

  it("does not let a failing dispose escape into unmount", () => {
    const addon = {
      ...fakeAddon(),
      dispose() {
        throw new Error("already gone");
      },
    };
    const dispose = attachWebglRenderer(
      "t1",
      terminalThatAccepts([]),
      () => addon as unknown as WebglRendererAddon,
    );

    expect(() => dispose?.()).not.toThrow();
  });
});
