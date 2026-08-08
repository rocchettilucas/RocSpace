import { Minus, Plus } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ZOOM,
  zoomIn,
  zoomLabel,
  zoomOut,
  ZOOM_STEPS,
} from "@/lib/zoom";
import { useSettingsStore, useThemeId, useZoom } from "@/stores";
import { THEMES } from "@/themes/registry";
import type { ThemeDefinition } from "@/themes/types";
import { SettingsRow, SettingsSection } from "@/views/Settings/rows";
import { ThemeCard } from "@/views/Settings/ThemeCard";

/** Dark first, then light — matching the registry's own order within each. */
const DARK_THEMES = THEMES.filter((t) => t.mode === "dark");
const LIGHT_THEMES = THEMES.filter((t) => t.mode === "light");

export function AppearanceSection() {
  const themeId = useThemeId();
  const setThemeId = useSettingsStore((s) => s.setThemeId);
  const groupRef = useRef<HTMLDivElement | null>(null);

  /** Radiogroup keyboard model: arrows move *and* select, so the theme applies
   *  as you arrow through it — which is the point of instant apply. Cards are
   *  read out of the DOM rather than tracked in state so the order here can
   *  never drift from the rendered order. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    // Autorepeat is not browsing. Holding an arrow fired ~30 theme switches a
    // second, each one repainting every token, re-theming every open xterm and
    // Monaco, and sending the native window an IPC call — for thirty themes
    // the user never saw. One press, one theme; the key has to come back up.
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    const cards = Array.from(
      groupRef.current?.querySelectorAll<HTMLElement>("[data-theme-card]") ??
        [],
    );
    if (cards.length === 0) return;
    e.preventDefault();
    const current = cards.findIndex((c) => c.dataset.themeCard === themeId);
    const next = cards[(current + delta + cards.length) % cards.length]!;
    const nextId = next.dataset.themeCard;
    if (nextId) setThemeId(nextId);
    next.focus();
  };

  return (
    <SettingsSection
      title="Appearance"
      description="Every accent, surface, and terminal color applies instantly — no restart, no reload."
    >
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Theme"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-5"
      >
        <ThemeGroup
          label="Dark"
          themes={DARK_THEMES}
          activeId={themeId}
          onSelect={setThemeId}
        />
        <ThemeGroup
          label="Light"
          themes={LIGHT_THEMES}
          activeId={themeId}
          onSelect={setThemeId}
        />
      </div>

      <div className="mt-6">
        <ZoomRow />
      </div>
    </SettingsSection>
  );
}

/** App zoom. Here rather than in Terminal because it is about the CHROME —
 *  sidebar, headers, dialogs, the board. A pane's own font size lives in
 *  Settings › Terminal and is deliberately not moved by this: how much
 *  scrollback fits on screen is a different question from how big the frame
 *  around it is, and answering both with one number is how people end up
 *  choosing between readable menus and a usable terminal. */
function ZoomRow() {
  const zoom = useZoom();
  const setZoom = useSettingsStore((s) => s.setZoom);
  const atMin = zoom <= ZOOM_STEPS[0]!;
  const atMax = zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

  return (
    <SettingsRow
      label="Zoom"
      description="Scales everything except the terminals — ⌘+ / ⌘− anywhere, ⌘0 back to 100%."
    >
      <ZoomButton
        label="Zoom out"
        icon={<Minus className="h-3.5 w-3.5" />}
        disabled={atMin}
        onClick={() => setZoom(zoomOut(zoom))}
      />
      <span
        aria-live="polite"
        className="w-12 text-center font-mono text-xs text-fg-secondary"
      >
        {zoomLabel(zoom)}
      </span>
      <ZoomButton
        label="Zoom in"
        icon={<Plus className="h-3.5 w-3.5" />}
        disabled={atMax}
        onClick={() => setZoom(zoomIn(zoom))}
      />
      <button
        type="button"
        onClick={() => setZoom(DEFAULT_ZOOM)}
        disabled={zoom === DEFAULT_ZOOM}
        className={cn(
          "rounded-input px-2.5 py-1 text-xs",
          zoom === DEFAULT_ZOOM
            ? "cursor-not-allowed text-fg-muted"
            : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        )}
      >
        Reset
      </button>
    </SettingsRow>
  );
}

function ZoomButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-input bg-surface-2 text-fg-primary",
        disabled ? "cursor-not-allowed opacity-40" : "hover:bg-surface-3",
      )}
    >
      {icon}
    </button>
  );
}

function ThemeGroup({
  label,
  themes,
  activeId,
  onSelect,
}: {
  label: string;
  themes: readonly ThemeDefinition[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (themes.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-fg-muted">
        {label}
      </h4>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            isActive={theme.id === activeId}
            onSelect={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}
