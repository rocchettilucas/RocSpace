/** App zoom — ⌘+ / ⌘− / ⌘0.
 *
 *  Implemented as the ROOT FONT SIZE rather than a CSS transform or the
 *  webview's own zoom, and that choice is the whole of the design:
 *
 *  * Tailwind's spacing, radii and type scales are all `rem`, so one number on
 *    `<html>` moves the entire chrome — padding, gaps, icon boxes, borders stay
 *    crisp — with no layer to rasterize and no blur.
 *  * A transform would scale a bitmap and break `position: fixed`, the native
 *    child webview the Browser mode hosts, and every hit-test in xterm.
 *  * The webview's own zoom would take the TERMINALS with it, which is wrong:
 *    a pane's font size is its own setting (Settings › Terminal) precisely
 *    because how much scrollback fits is a different question from how big the
 *    chrome is. Zoom moves the frame; the terminal keeps the size it was told.
 *
 *  The ladder is discrete for the usual reason a stepper is: ⌘+ should land
 *  somewhere legible every time rather than creeping by 10% and leaving the user
 *  to find 100% again. ⌘0 is that way back. */

/** What ⌘+ and ⌘− walk through. `1` must be in the list — it is what ⌘0
 *  returns to, and what a fresh install runs at. */
export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];

export const DEFAULT_ZOOM = 1;

const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** What 100% means, in pixels.
 *
 *  The webview's own root font size, read ONCE at module load and never again.
 *  Read rather than assumed because "16" is only the default: a user who has
 *  raised the default text size in their browser or OS has done so because they
 *  need it, and an app that wrote `16px` over that at boot would take an
 *  accessibility setting away silently — the app would come up SMALLER than
 *  everything else on the machine, and the only way back would be ⌘+ every
 *  launch.
 *
 *  Once is the whole discipline. `applyZoom` writes an inline `font-size` on
 *  the same element, so re-reading would compound: each ⌘+ would scale the
 *  result of the last one and the ladder would drift off its own rungs. This
 *  runs before the first write, which is what makes the value read the user's
 *  and not ours.
 *
 *  A hoisted function declaration so the constant can call it: `zoom.ts` is
 *  imported by the settings store, which is imported by `main.tsx` before the
 *  first paint, and the document exists by then. Without one (a Node-side
 *  test), 16 is the honest fallback — nothing will be painted either. */
const FALLBACK_BASE_FONT_PX = 16;

const BASE_FONT_PX = readRootFontSize();

function readRootFontSize(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function")
    return FALLBACK_BASE_FONT_PX;
  const parsed = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  // A computed size of 0 or NaN is not a size anyone asked for; it means the
  // read failed, and scaling from it would leave the app unreadable.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_BASE_FONT_PX;
}

/** Nearest step to `value`, so a hand-edited settings file (or a future slider)
 *  still lands on the ladder ⌘+ walks. */
export function nearestZoomStep(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  let best = ZOOM_STEPS[0]!;
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - clamped) < Math.abs(best - clamped)) best = step;
  }
  return best;
}

/** The next step up, or the same one at the top of the ladder — a ⌘+ that
 *  cannot go further does nothing rather than wrapping around to tiny. */
export function zoomIn(current: number): number {
  const at = ZOOM_STEPS.indexOf(nearestZoomStep(current));
  return ZOOM_STEPS[Math.min(at + 1, ZOOM_STEPS.length - 1)]!;
}

export function zoomOut(current: number): number {
  const at = ZOOM_STEPS.indexOf(nearestZoomStep(current));
  return ZOOM_STEPS[Math.max(at - 1, 0)]!;
}

/** Paint it. Idempotent, and safe without a document (a Node-side test): the
 *  same discipline `themes/apply.ts` follows.
 *
 *  Idempotent BECAUSE the base is captured once — the multiplication is always
 *  against what the webview handed us, never against what this function wrote
 *  last time. Rounded to a tenth of a pixel so the string is stable: 0.9 × 16
 *  is 14.400000000000002 in binary floating point, and a font-size that
 *  differs in its fifteenth digit between two applications of the same step is
 *  a diff for anyone reading the DOM. */
export function applyZoom(scale: number): void {
  if (typeof document === "undefined") return;
  const px = Math.round(BASE_FONT_PX * nearestZoomStep(scale) * 10) / 10;
  document.documentElement.style.fontSize = `${px}px`;
}

/** How the level reads in the UI: "110%". */
export function zoomLabel(scale: number): string {
  return `${Math.round(nearestZoomStep(scale) * 100)}%`;
}
