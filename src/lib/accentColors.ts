/** The workspace accent palette.
 *
 *  Replaces `groupColors.ts`: with groups retired, the accent a pane wears is
 *  its *workspace's*, and the six slots that used to distinguish groups inside
 *  one project now distinguish projects from each other. The mapping is the
 *  same six theme tokens, so an accent re-colours with the active theme instead
 *  of carrying a literal — `accentVar()` returns a `var(--rs-*)` reference the
 *  browser re-resolves on a theme switch, with no React render involved.
 *  `accentHex()` is the literal form, for previews and canvases that cannot
 *  resolve a custom property.
 *
 *  Slot names are persisted on the workspace, so they are data: renaming one is
 *  a migration. */

import { CSS_VAR_BY_TOKEN } from "@/themes/apply";
import type { WorkspaceAccent } from "@/lib/bindings";
import type { ThemeDefinition, ThemeTokenKey } from "@/themes/types";

/** Every accent, in the order `createWorkspace` hands them out. */
export const WORKSPACE_ACCENTS: readonly WorkspaceAccent[] = [
  "violet",
  "cyan",
  "green",
  "amber",
  "rose",
  "blue",
];

/** Which theme token each accent renders with. Ported unchanged from the group
 *  palette so a migrated workspace keeps the colour its project always had. */
export const ACCENT_TOKEN: Record<WorkspaceAccent, ThemeTokenKey> = {
  violet: "purple",
  cyan: "info",
  green: "success",
  amber: "warning",
  rose: "danger",
  blue: "primary",
};

export const ACCENT_LABEL: Record<WorkspaceAccent, string> = {
  violet: "Violet",
  cyan: "Cyan",
  green: "Green",
  amber: "Amber",
  rose: "Rose",
  blue: "Blue",
};

const ACCENT_VAR: Record<WorkspaceAccent, string> = {
  violet: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.violet]})`,
  cyan: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.cyan]})`,
  green: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.green]})`,
  amber: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.amber]})`,
  rose: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.rose]})`,
  blue: `var(${CSS_VAR_BY_TOKEN[ACCENT_TOKEN.blue]})`,
};

/** The accent a workspace created `order`-th gets. Stored on the workspace, so
 *  it stays put when the sidebar is reordered or an earlier one is closed. */
export function accentForOrder(order: number): WorkspaceAccent {
  const slots = WORKSPACE_ACCENTS.length;
  // `order` can arrive negative from a bad snapshot; `%` alone would index out.
  const index = ((order % slots) + slots) % slots;
  return WORKSPACE_ACCENTS[index]!;
}

/** Coerce an untrusted value (a persisted snapshot, a hand-edited store file)
 *  to a real accent. Falls back to the order-based default rather than failing
 *  a load over a colour. */
export function resolveAccent(stored: unknown, order = 0): WorkspaceAccent {
  if (
    typeof stored === "string" &&
    (WORKSPACE_ACCENTS as readonly string[]).includes(stored)
  ) {
    return stored as WorkspaceAccent;
  }
  return accentForOrder(order);
}

/** CSS colour for an accent, as a theme-variable reference (live re-themes). */
export function accentVar(accent: WorkspaceAccent): string {
  return ACCENT_VAR[accent];
}

/** Literal colour for an accent under `theme` — previews, canvases, anything
 *  that cannot resolve a custom property. */
export function accentHex(
  accent: WorkspaceAccent,
  theme: ThemeDefinition,
): string {
  return theme.tokens[ACCENT_TOKEN[accent]];
}

/** All six accents resolved against one theme, in `WORKSPACE_ACCENTS` order. */
export function accentPalette(
  theme: ThemeDefinition,
): Record<WorkspaceAccent, string> {
  return {
    violet: accentHex("violet", theme),
    cyan: accentHex("cyan", theme),
    green: accentHex("green", theme),
    amber: accentHex("amber", theme),
    rose: accentHex("rose", theme),
    blue: accentHex("blue", theme),
  };
}
