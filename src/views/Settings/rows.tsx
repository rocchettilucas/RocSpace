import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The two layout primitives every Settings section is built from.
 *
 *  Keeping them here (rather than letting each section hand-roll its own
 *  markup) is what makes the surface read as one screen: identical heading
 *  rhythm, identical label/description/control geometry, one place to change
 *  the spacing. Sections supply content and controls, never chrome. */

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="max-w-3xl">
      <h3
        id={headingId}
        className="text-sm font-semibold tracking-tight text-fg-primary"
      >
        {title}
      </h3>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-fg-secondary">
          {description}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One labelled control. `htmlFor` wires the label to a single input; leave it
 *  off for composite controls (radio groups, button clusters) and give the
 *  control its own `aria-label` / `aria-labelledby` instead. */
export function SettingsRow({
  label,
  description,
  htmlFor,
  stacked = false,
  children,
  className,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  /** Put the control on its own line under the label — for controls too wide
   *  to sit beside it (radio lists, tables). */
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const labelClass = "block text-xs font-medium text-fg-primary";

  const text = (
    <div className="min-w-0 flex-1">
      {/* The description stays OUT of the <label>: everything inside it
          becomes part of the control's accessible name, and a whole sentence
          of prose read out before every value is worse than useless. */}
      {htmlFor ? (
        <label htmlFor={htmlFor} className={cn(labelClass, "cursor-pointer")}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      {description ? (
        <span className="mt-0.5 block text-[11px] leading-relaxed text-fg-muted">
          {description}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "border-b border-border py-3 last:border-b-0",
        !stacked && "flex items-start justify-between gap-6",
        className,
      )}
    >
      {text}
      {children ? (
        <div
          className={cn(
            stacked ? "mt-2.5" : "flex shrink-0 items-center gap-2",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** On/off switch. `role="switch"` rather than a checkbox: nothing is being
 *  submitted, the change takes effect immediately. */
export function SettingsToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-surface-3",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-surface-0 transition-[left]",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/** Full-width note at the end of a section — scope caveats, "wiring lands in
 *  Phase N", safety warnings. */
export function SettingsNote({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "mt-4 rounded-input border px-3 py-2 text-[11px] leading-relaxed",
        tone === "warning"
          ? "border-warning/40 bg-warning/10 text-fg-secondary"
          : "border-border bg-surface-1 text-fg-muted",
      )}
    >
      {children}
    </p>
  );
}
