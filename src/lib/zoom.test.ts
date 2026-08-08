/** The zoom ladder, and the one thing it writes to the document. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyZoom,
  DEFAULT_ZOOM,
  nearestZoomStep,
  zoomIn,
  zoomLabel,
  zoomOut,
  ZOOM_STEPS,
} from "@/lib/zoom";

const first = ZOOM_STEPS[0]!;
const last = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

afterEach(() => {
  document.documentElement.style.fontSize = "";
});

describe("the ladder", () => {
  // ⌘0 has to land on a rung, or "back to 100%" would be a value ⌘+ then
  // rounds away from.
  it("contains 100%", () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
    expect(DEFAULT_ZOOM).toBe(1);
  });

  it("is ascending and free of duplicates", () => {
    const sorted = [...ZOOM_STEPS].sort((a, b) => a - b);
    expect(ZOOM_STEPS).toEqual(sorted);
    expect(new Set(ZOOM_STEPS).size).toBe(ZOOM_STEPS.length);
  });
});

describe("nearestZoomStep", () => {
  it("snaps a value between rungs to the closer one", () => {
    expect(nearestZoomStep(1.02)).toBe(1);
    expect(nearestZoomStep(1.19)).toBe(1.2);
  });

  it("clamps outside the ladder rather than extrapolating", () => {
    expect(nearestZoomStep(0.1)).toBe(first);
    expect(nearestZoomStep(9)).toBe(last);
  });

  // A hand-edited settings file is the reachable case.
  it("falls back to 100% for anything that is not a number", () => {
    expect(nearestZoomStep(NaN)).toBe(DEFAULT_ZOOM);
    expect(nearestZoomStep(Infinity)).toBe(DEFAULT_ZOOM);
  });
});

describe("zoomIn / zoomOut", () => {
  it("walk one rung at a time", () => {
    expect(zoomIn(1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) + 1]);
    expect(zoomOut(1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) - 1]);
  });

  // Wrapping would answer "too small to read" with "smallest possible".
  it("stop at the ends instead of wrapping", () => {
    expect(zoomIn(last)).toBe(last);
    expect(zoomOut(first)).toBe(first);
  });

  it("snap an off-ladder starting point before stepping", () => {
    expect(zoomOut(1.02)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) - 1]);
  });
});

describe("applyZoom", () => {
  it("writes the root font size, snapped to a rung", () => {
    applyZoom(1.2);
    expect(document.documentElement.style.fontSize).toBe("19.2px");

    applyZoom(1);
    expect(document.documentElement.style.fontSize).toBe("16px");
  });

  // Re-applying must not compound: the base is read once, not re-read off the
  // element this function just wrote to.
  it("is idempotent", () => {
    applyZoom(1.5);
    const once = document.documentElement.style.fontSize;
    applyZoom(1.5);
    expect(document.documentElement.style.fontSize).toBe(once);
  });

  // The accessibility case, and the reason the base is read at all: a user who
  // has raised their default text size must not have it written over at boot.
  // A fresh module instance because the base is captured once, at load — which
  // is exactly the behaviour under test.
  it("scales from a raised default rather than assuming 16px", async () => {
    document.documentElement.style.fontSize = "20px";
    vi.resetModules();
    const zoom = await import("@/lib/zoom");

    // 100% is what the user already had, not the browser's default.
    zoom.applyZoom(1);
    expect(document.documentElement.style.fontSize).toBe("20px");

    zoom.applyZoom(1.2);
    expect(document.documentElement.style.fontSize).toBe("24px");

    // And re-applying still does not compound, now that the element carries a
    // size this module wrote.
    zoom.applyZoom(1.2);
    expect(document.documentElement.style.fontSize).toBe("24px");
  });
});

describe("zoomLabel", () => {
  it("reads as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.35)).toBe("135%");
    expect(zoomLabel(0.8)).toBe("80%");
  });
});
