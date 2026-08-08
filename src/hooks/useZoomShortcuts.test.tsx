/** ⌘+ / ⌘− / ⌘0 — including the two rules that make zoom unlike every other
 *  chord in the app. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";

/** Settings writes are debounced; without a stand-in the timer fires into a
 *  missing Tauri runtime after the test has finished. */
vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    static async load(): Promise<FakeStore> {
      return new FakeStore();
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  }
  return { Store: FakeStore };
});

const { DEFAULT_ZOOM, ZOOM_STEPS } = await import("@/lib/zoom");
const { useSettingsStore } = await import("@/stores/settings");
const { useUIStore } = await import("@/stores/ui");
const { useZoomShortcuts } = await import("@/hooks/useZoomShortcuts");

const zoom = () => useSettingsStore.getState().zoom;
const up = ZOOM_STEPS[ZOOM_STEPS.indexOf(DEFAULT_ZOOM) + 1]!;
const down = ZOOM_STEPS[ZOOM_STEPS.indexOf(DEFAULT_ZOOM) - 1]!;

const press = (key: string, target: Document | Element = document) =>
  fireEvent.keyDown(target, { key, metaKey: true });

beforeEach(() => {
  useSettingsStore.setState({ zoom: DEFAULT_ZOOM });
  useUIStore.setState({ isSettingsOpen: false, isCommandPaletteOpen: false });
});

describe("useZoomShortcuts", () => {
  it("⌘+ and ⌘= both step up; ⌘− and ⌘_ both step down", () => {
    renderHook(() => useZoomShortcuts());

    press("+");
    expect(zoom()).toBe(up);
    press("-");
    expect(zoom()).toBe(DEFAULT_ZOOM);

    press("=");
    expect(zoom()).toBe(up);
    press("_");
    expect(zoom()).toBe(DEFAULT_ZOOM);
  });

  it("⌘0 goes back to 100% from either direction", () => {
    renderHook(() => useZoomShortcuts());

    press("-");
    expect(zoom()).toBe(down);
    press("0");
    expect(zoom()).toBe(DEFAULT_ZOOM);
  });

  it("paints the root font size, not just the store", () => {
    renderHook(() => useZoomShortcuts());

    press("+");
    expect(document.documentElement.style.fontSize).toBe(`${16 * up}px`);
  });

  it("claims the event so the webview's own zoom does not also fire", () => {
    renderHook(() => useZoomShortcuts());

    const event = new KeyboardEvent("keydown", {
      key: "+",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  // Every other chord stands down under a modal. This one must not: it is what
  // you reach for when you cannot read the dialog that is asking you something.
  it("keeps working while a modal owns the app", () => {
    renderHook(() => useZoomShortcuts());
    useUIStore.setState({ isSettingsOpen: true, isCommandPaletteOpen: true });

    press("+");
    expect(zoom()).toBe(up);
  });

  it("keeps working from inside a text field", () => {
    renderHook(() => useZoomShortcuts());
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    press("+", field);
    expect(zoom()).toBe(up);
    field.remove();
  });

  it("ignores the same keys without ⌘, and with ⌃ or ⌥", () => {
    renderHook(() => useZoomShortcuts());

    fireEvent.keyDown(document, { key: "+" });
    fireEvent.keyDown(document, { key: "+", ctrlKey: true });
    fireEvent.keyDown(document, { key: "+", metaKey: true, altKey: true });
    expect(zoom()).toBe(DEFAULT_ZOOM);
  });

  // ⌘1–⌘9 are the workspace switcher's; zoom must not eat one.
  it("leaves ⌘1 alone", () => {
    renderHook(() => useZoomShortcuts());

    const event = new KeyboardEvent("keydown", {
      key: "1",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(zoom()).toBe(DEFAULT_ZOOM);
  });
});
