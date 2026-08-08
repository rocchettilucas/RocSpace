import { ExternalLink, Sparkles } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import rocLogo from "@/assets/roc-logo.png";
import { useAppVersion } from "@/hooks/useAppVersion";
import { LATEST_ENTRY } from "@/lib/changelog";
import { useUIStore } from "@/stores";
import { SettingsRow, SettingsSection } from "@/views/Settings/rows";

const REPO_URL = "https://github.com/rocchettilucas/RocSpace";

export function AboutSection() {
  const version = useAppVersion();

  return (
    <SettingsSection title="About">
      <div className="mb-4 flex items-center gap-3">
        <img
          src={rocLogo}
          alt=""
          draggable={false}
          className="h-10 w-10 select-none object-contain"
        />
        <div>
          <p className="text-sm font-semibold tracking-tight text-fg-primary">
            RocSpace
          </p>
          <p className="text-xs text-fg-muted">
            Multi-agent terminal workspace
          </p>
        </div>
      </div>

      <SettingsRow label="Version">
        <span className="font-mono text-xs text-fg-secondary">
          {version ?? "—"}
        </span>
      </SettingsRow>

      {LATEST_ENTRY ? (
        <SettingsRow
          label="What's new"
          description={
            LATEST_ENTRY.title
              ? `${LATEST_ENTRY.title}${LATEST_ENTRY.date ? ` — ${LATEST_ENTRY.date}` : ""}`
              : "The latest entry from CHANGELOG.md"
          }
        >
          <button
            type="button"
            onClick={() => useUIStore.getState().openWhatsNew()}
            className="flex items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors hover:bg-surface-3"
          >
            <Sparkles className="h-3 w-3" />
            Read it again
          </button>
        </SettingsRow>
      ) : null}

      <SettingsRow label="Source" description={REPO_URL}>
        <button
          type="button"
          onClick={() => {
            openUrl(REPO_URL).catch((err) => {
              console.warn("[settings] openUrl failed:", err);
            });
          }}
          className="flex items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors hover:bg-surface-3"
        >
          <ExternalLink className="h-3 w-3" />
          Open on GitHub
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}

/** `null` until it resolves, and permanently `null` without a Tauri runtime
 *  (plain `vite dev`, tests) — the version simply reads "—" there rather than
 *  taking the pane down. */
