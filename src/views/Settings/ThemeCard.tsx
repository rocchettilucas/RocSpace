import { Moon, Sun } from "lucide-react";
import { WORKSPACE_ACCENTS, accentPalette } from "@/lib/accentColors";
import { cn } from "@/lib/utils";
import type { ThemeDefinition } from "@/themes/types";

/** One selectable theme.
 *
 *  The card's own chrome (border, text, ACTIVE pill) is painted with the
 *  *active* theme's Tailwind tokens so the picker matches the app around it.
 *  Everything inside the preview is painted with **this** theme's tokens, as
 *  inline styles — that is the whole point of the card, and it is the one place
 *  in the app where hard-coded-looking colors are correct. */
export function ThemeCard({
  theme,
  isActive,
  onSelect,
}: {
  theme: ThemeDefinition;
  isActive: boolean;
  onSelect: () => void;
}) {
  const ModeIcon = theme.mode === "dark" ? Moon : Sun;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      // Roving tabindex: the group is one tab stop, arrows move within it.
      tabIndex={isActive ? 0 : -1}
      data-theme-card={theme.id}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-card border p-2.5 text-left transition-colors",
        isActive
          ? "border-accent bg-accent-soft"
          : "border-border bg-surface-1 hover:border-border-hover hover:bg-surface-2",
      )}
    >
      <ThemePreview theme={theme} />

      <div className="flex items-center gap-1.5">
        <ModeIcon className="h-3 w-3 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-primary">
          {theme.name}
        </span>
        {isActive ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent-fg">
            <span aria-hidden="true">●</span>
            Active
          </span>
        ) : null}
      </div>

      <p className="text-[11px] leading-snug text-fg-muted">
        {theme.description}
      </p>
    </button>
  );
}

/** Mini window: title bar with traffic dots, sidebar column, content column
 *  with a primary pill and the six workspace accents. Decorative — the card's
 *  accessible name is the theme name below it. */
function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  const t = theme.tokens;
  const accents = accentPalette(theme);

  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-input border"
      style={{ background: t.background, borderColor: t.border }}
    >
      {/* Title bar */}
      <div
        className="flex h-4 items-center gap-1 border-b px-1.5"
        style={{ background: t.panel, borderColor: t.border }}
      >
        {[t.danger, t.warning, t.success].map((color, i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: color }}
          />
        ))}
      </div>

      <div className="flex h-16">
        {/* Sidebar */}
        <div
          className="flex w-1/4 flex-col gap-1 border-r p-1.5"
          style={{ background: t.panel, borderColor: t.border }}
        >
          <span
            className="h-1 w-full rounded-full"
            style={{ background: t.surfaceActive }}
          />
          <span
            className="h-1 w-3/4 rounded-full"
            style={{ background: t.surface }}
          />
          <span
            className="h-1 w-2/3 rounded-full"
            style={{ background: t.surface }}
          />
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col gap-1 p-1.5">
          <span
            className="h-2 w-full rounded-sm"
            style={{ background: t.surface }}
          />
          <span
            className="h-1 w-4/5 rounded-full"
            style={{ background: t.termFg, opacity: 0.7 }}
          />
          <span
            className="h-1 w-3/5 rounded-full"
            style={{ background: t.text3 }}
          />

          <div className="mt-auto flex items-center gap-1.5">
            <span
              className="h-2.5 w-8 rounded-full"
              style={{ background: t.primary }}
            />
            <span className="flex items-center gap-[3px]">
              {WORKSPACE_ACCENTS.map((accent) => (
                <span
                  key={accent}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: accents[accent] }}
                />
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
