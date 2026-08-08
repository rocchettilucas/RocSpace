import { afterEach, describe, expect, it, vi } from "vitest";

/** Stand-in for the Tauri window handle. `runtime` is null by default, which
 *  reproduces plain `vite dev` / jsdom: `getCurrentWindow()` throws outright
 *  because `window.__TAURI_INTERNALS__` is not there. */
const { runtime, setBackgroundColor, setTheme } = vi.hoisted(() => ({
  runtime: { present: false },
  setBackgroundColor: vi.fn<(color: unknown) => Promise<void>>(),
  setTheme: vi.fn<(mode: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (!runtime.present) throw new TypeError("no tauri here");
    return { setTheme, setBackgroundColor };
  },
}));

const { syncNativeWindowTheme } = await import("@/themes/nativeWindow");
const { applyThemeDefinition } = await import("@/themes/apply");
const { getTheme, THEMES } = await import("@/themes/registry");

const lightTheme = THEMES.find((t) => t.mode === "light")!;
const darkTheme = getTheme("rocspace-dark");

describe("syncNativeWindowTheme", () => {
  afterEach(() => {
    runtime.present = false;
    setTheme.mockReset();
    setBackgroundColor.mockReset();
  });

  it("is a no-op — and never throws — without a Tauri runtime", () => {
    expect(() => syncNativeWindowTheme(lightTheme)).not.toThrow();
    expect(setTheme).not.toHaveBeenCalled();
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it("pushes the mode to the window when a runtime is there", () => {
    runtime.present = true;
    setTheme.mockResolvedValue(undefined);
    setBackgroundColor.mockResolvedValue(undefined);

    syncNativeWindowTheme(lightTheme);

    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("pushes the theme's background as window channels", () => {
    runtime.present = true;
    setTheme.mockResolvedValue(undefined);
    setBackgroundColor.mockResolvedValue(undefined);

    // The conf file pins #0a0c14 as the boot default; every other theme has to
    // arrive here or a resize on a light theme flashes near-black.
    syncNativeWindowTheme(darkTheme);
    expect(setBackgroundColor).toHaveBeenLastCalledWith([0x0a, 0x0c, 0x14]);

    syncNativeWindowTheme(lightTheme);
    const { r, g, b } = hexToRgb(lightTheme.tokens.background);
    expect(setBackgroundColor).toHaveBeenLastCalledWith([r, g, b]);
  });

  it("swallows a rejected setTheme (missing permission, OS refusal)", async () => {
    runtime.present = true;
    setTheme.mockRejectedValue(new Error("forbidden"));
    setBackgroundColor.mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => syncNativeWindowTheme(darkTheme)).not.toThrow();
    await Promise.resolve();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns once for a rejected setBackgroundColor, not once per theme switch", async () => {
    // Fresh module graph so the one-shot warn flag has not been tripped by an
    // earlier test in this file.
    vi.resetModules();
    const fresh = await import("@/themes/nativeWindow");
    runtime.present = true;
    setTheme.mockResolvedValue(undefined);
    setBackgroundColor.mockRejectedValue(new Error("forbidden"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => fresh.syncNativeWindowTheme(darkTheme)).not.toThrow();
    await Promise.resolve();
    fresh.syncNativeWindowTheme(lightTheme);
    await Promise.resolve();

    expect(setBackgroundColor).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("applyThemeDefinition carries the theme's mode and background", () => {
    runtime.present = true;
    setTheme.mockResolvedValue(undefined);
    setBackgroundColor.mockResolvedValue(undefined);

    applyThemeDefinition(lightTheme);
    expect(setTheme).toHaveBeenLastCalledWith("light");
    const light = hexToRgb(lightTheme.tokens.background);
    expect(setBackgroundColor).toHaveBeenLastCalledWith([
      light.r,
      light.g,
      light.b,
    ]);

    applyThemeDefinition(darkTheme);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(setBackgroundColor).toHaveBeenLastCalledWith([0x0a, 0x0c, 0x14]);
  });
});

/** Deliberately not `parseColor` — the test should not agree with the code by
 *  sharing its parser. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`test expects a #rrggbb token, got ${hex}`);
  return {
    r: parseInt(m[1]!, 16),
    g: parseInt(m[2]!, 16),
    b: parseInt(m[3]!, 16),
  };
}
