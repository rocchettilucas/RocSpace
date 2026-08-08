import {
  Archive,
  Bell,
  Info,
  Keyboard,
  Mic,
  Palette,
  SquareTerminal,
  Bot,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsSectionId } from "@/stores/ui";

interface SectionMeta {
  label: string;
  icon: LucideIcon;
}

/** Label + icon per section. A `Record` over the union on purpose: adding a
 *  section id in `stores/ui.ts` fails to compile until it is described here,
 *  so the nav can never silently miss one.
 *
 *  Exported because the command palette offers one action per section and has
 *  to call each of them what the nav calls it — a palette that says "Keyboard"
 *  where the nav says "Shortcuts" is two names for one place. */
export const SECTION_META: Record<SettingsSectionId, SectionMeta> = {
  appearance: { label: "Appearance", icon: Palette },
  terminal: { label: "Terminal", icon: SquareTerminal },
  agents: { label: "Agents", icon: Bot },
  notifications: { label: "Notifications", icon: Bell },
  voice: { label: "Voice", icon: Mic },
  shortcuts: { label: "Shortcuts", icon: Keyboard },
  history: { label: "History", icon: Archive },
  about: { label: "About", icon: Info },
};

/** Render order — and the order the palette lists the sections in. */
export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = [
  "appearance",
  "terminal",
  "agents",
  "notifications",
  "voice",
  "shortcuts",
  "history",
  "about",
];

export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface-1 p-2"
    >
      {SETTINGS_SECTIONS.map((id) => {
        const { label, icon: Icon } = SECTION_META[id];
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            // `aria-current` (not aria-selected): these are navigation links
            // into one pane, not tabs owning separate tabpanels.
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              "flex items-center gap-2 rounded-input px-2.5 py-1.5 text-left text-xs transition-colors",
              isActive
                ? "bg-accent-soft font-medium text-fg-primary"
                : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
            )}
          >
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                isActive ? "text-accent" : "text-fg-muted",
              )}
            />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
