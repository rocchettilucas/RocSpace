import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SCROLLBACK_OPTIONS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
  useTerminalSettings,
} from "@/stores";
import { SettingsRow, SettingsSection } from "@/views/Settings/rows";

export function TerminalSection() {
  const { fontSize, scrollback } = useTerminalSettings();
  const setTerminalOption = useSettingsStore((s) => s.setTerminalOption);
  const scrollbackId = useId();

  // A value restored from an older (or newer) settings file may not be one of
  // today's presets. Offer it rather than silently snapping the user to a
  // different number the moment they open this pane.
  const scrollbackChoices = SCROLLBACK_OPTIONS.includes(
    scrollback as (typeof SCROLLBACK_OPTIONS)[number],
  )
    ? SCROLLBACK_OPTIONS
    : [...SCROLLBACK_OPTIONS, scrollback].sort((a, b) => a - b);

  return (
    <SettingsSection
      title="Terminal"
      description="Applies to every open terminal immediately — no respawn."
    >
      <SettingsRow
        label="Font size"
        description={`${TERMINAL_FONT_SIZE_MIN}–${TERMINAL_FONT_SIZE_MAX}px. Panes refit to the new cell size as you step.`}
      >
        <Stepper
          label="Terminal font size"
          value={fontSize}
          min={TERMINAL_FONT_SIZE_MIN}
          max={TERMINAL_FONT_SIZE_MAX}
          unit="px"
          onChange={(v) => setTerminalOption("fontSize", v)}
        />
      </SettingsRow>

      <SettingsRow
        label="Scrollback"
        description="Lines kept per terminal. Lowering it trims what open terminals already hold."
        htmlFor={scrollbackId}
      >
        <select
          id={scrollbackId}
          value={scrollback}
          onChange={(e) =>
            setTerminalOption("scrollback", Number(e.target.value))
          }
          className="rounded-input border border-border bg-surface-2 px-2 py-1 text-xs text-fg-primary hover:border-border-hover focus:border-border-active focus:outline-none"
        >
          {scrollbackChoices.map((lines) => (
            <option key={lines} value={lines}>
              {lines.toLocaleString()} lines
            </option>
          ))}
        </select>
      </SettingsRow>

      <div className="mt-4 overflow-hidden rounded-input border border-border bg-surface-0">
        <div className="border-b border-border bg-surface-1 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Preview
        </div>
        <pre
          className="allow-select overflow-x-auto px-2.5 py-2 font-mono text-fg-primary"
          style={{ fontSize, lineHeight: 1.2 }}
        >
          <span className="text-accent">❯</span> claude --resume{"\n"}
          <span className="text-fg-secondary">
            Reading src/views/RocDock/useXterm.ts…
          </span>
          {"\n"}
          <span className="text-success">✓</span> 3 files changed
        </pre>
      </div>
    </SettingsSection>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-input border border-border bg-surface-1 p-0.5"
    >
      <StepButton
        label={`Decrease ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="h-3 w-3" />
      </StepButton>
      <span
        aria-live="polite"
        className="w-12 text-center text-xs tabular-nums text-fg-primary"
      >
        {value}
        {unit}
      </span>
      <StepButton
        label={`Increase ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="h-3 w-3" />
      </StepButton>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded-[4px] transition-colors",
        disabled
          ? "cursor-not-allowed text-fg-muted opacity-40"
          : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
      )}
    >
      {children}
    </button>
  );
}
