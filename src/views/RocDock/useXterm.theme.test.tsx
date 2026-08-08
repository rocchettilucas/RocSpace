/** Live settings wiring for terminals: mounting a pane registers its xterm
 *  instance, a theme switch repaints every live instance, a font-size or
 *  scrollback change lands on them too, unmounting cleans up. Mounting a real
 *  xterm in jsdom needs two browser APIs jsdom lacks. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { getTerminal } from "@/lib/terminalRegistry";
import { DEFAULT_TERMINAL_SETTINGS, useSettingsStore } from "@/stores/settings";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "@/themes/registry";
import { xtermThemeFor } from "@/themes/xterm";
import { useXterm } from "@/views/RocDock/useXterm";

window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

function TerminalHost({ id }: { id: string }) {
  const { containerRef } = useXterm(id);
  return <div ref={containerRef} />;
}

/** A theme id that is not the active one. Falls back to an unknown id (which
 *  resolves to the default) while the registry only ships one theme. */
function otherThemeId(): string {
  const active = useSettingsStore.getState().themeId;
  return THEMES.find((t) => t.id !== active)?.id ?? "not-a-theme";
}

describe("useXterm theme wiring", () => {
  beforeEach(() => {
    useSettingsStore.setState({ themeId: DEFAULT_THEME_ID });
  });

  afterEach(() => {
    useSettingsStore.setState({ themeId: DEFAULT_THEME_ID });
  });

  it("registers the live terminal and drops it on unmount", () => {
    const view = render(<TerminalHost id="term-1" />);
    expect(getTerminal("term-1")).toBeDefined();

    view.unmount();
    expect(getTerminal("term-1")).toBeUndefined();
  });

  it("boots the terminal on the active theme's palette", () => {
    render(<TerminalHost id="term-2" />);

    expect(getTerminal("term-2")?.options.theme).toEqual(
      xtermThemeFor(getTheme(DEFAULT_THEME_ID)),
    );
  });

  it("repaints every live terminal when the theme changes", () => {
    render(<TerminalHost id="term-3" />);
    render(<TerminalHost id="term-4" />);
    const nextId = otherThemeId();

    // Clobber the palettes so the assertion can only pass if the subscription
    // actually pushed a fresh theme into each instance.
    getTerminal("term-3")!.options.theme = { background: "#123456" };
    getTerminal("term-4")!.options.theme = { background: "#123456" };

    useSettingsStore.setState({ themeId: nextId });

    const expected = xtermThemeFor(getTheme(nextId));
    expect(getTerminal("term-3")?.options.theme).toEqual(expected);
    expect(getTerminal("term-4")?.options.theme).toEqual(expected);
  });

  it("stops listening once the pane unmounts", () => {
    const view = render(<TerminalHost id="term-5" />);
    const term = getTerminal("term-5")!;
    view.unmount();

    term.options.theme = { background: "#123456" };
    useSettingsStore.setState({ themeId: otherThemeId() });

    expect(term.options.theme).toEqual({ background: "#123456" });
  });
});

describe("useXterm terminal-option wiring", () => {
  beforeEach(() => {
    useSettingsStore.setState({ terminal: { ...DEFAULT_TERMINAL_SETTINGS } });
  });

  afterEach(() => {
    useSettingsStore.setState({ terminal: { ...DEFAULT_TERMINAL_SETTINGS } });
  });

  it("boots on the stored font size and scrollback", () => {
    useSettingsStore.setState({ terminal: { fontSize: 15, scrollback: 2000 } });
    render(<TerminalHost id="term-6" />);

    expect(getTerminal("term-6")?.options.fontSize).toBe(15);
    expect(getTerminal("term-6")?.options.scrollback).toBe(2000);
  });

  it("pushes later changes into every live terminal", () => {
    render(<TerminalHost id="term-7" />);
    render(<TerminalHost id="term-8" />);

    useSettingsStore.setState({ terminal: { fontSize: 18, scrollback: 1000 } });

    for (const id of ["term-7", "term-8"]) {
      expect(getTerminal(id)?.options.fontSize).toBe(18);
      expect(getTerminal(id)?.options.scrollback).toBe(1000);
    }
  });

  it("stops listening once the pane unmounts", () => {
    const view = render(<TerminalHost id="term-9" />);
    const term = getTerminal("term-9")!;
    view.unmount();

    useSettingsStore.setState({ terminal: { fontSize: 19, scrollback: 1000 } });

    expect(term.options.fontSize).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize);
  });
});
