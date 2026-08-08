import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores";
import { DEFAULT_BROWSER_URL } from "@/stores/editor";
import { commands } from "@/lib/bindings";
import { normalizeBrowserAddress } from "@/views/WebPreview/browserAddress";

/** In-app browser preview backed by a native Tauri child webview overlaid on
 *  this component's host `<div>`. We use a child webview (not an iframe)
 *  because most major sites (youtube.com, google.com, github.com, …) set
 *  `X-Frame-Options` / `frame-ancestors` headers that forbid embedding inside
 *  an iframe. A native webview is a top-level navigation as far as the
 *  destination is concerned, so those policies don't apply.
 *
 *  Lifecycle:
 *   - On mount: call `web_preview_show(url, bbox)`. Rust creates the webview
 *     as a child of the main window and positions it over the host div.
 *   - On URL change: re-call `web_preview_show` (idempotent — Rust navigates
 *     and repositions an existing webview).
 *   - On host resize (ResizeObserver): `web_preview_set_bounds` to track.
 *   - On unmount (mode switch away from Browser): `web_preview_close` so we
 *     don't leak a webview behind the next mode's UI. */
export function WebPreview() {
  const url = useEditorStore((s) => s.browserUrl);
  const setBrowserUrl = useEditorStore((s) => s.setBrowserUrl);

  const previewUrl = url.trim()
    ? normalizeBrowserAddress(url)
    : `${DEFAULT_BROWSER_URL}/`;
  const [draft, setDraft] = useState(url);
  // Reset the address input whenever the committed URL changes.
  // Adjusting state during render (React's documented pattern for
  // derive-from-props) rather than in an effect: the effect version renders
  // once with the stale draft before correcting itself.
  const [lastUrl, setLastUrl] = useState(url);
  if (url !== lastUrl) {
    setLastUrl(url);
    setDraft(url);
  }

  const hostRef = useRef<HTMLDivElement | null>(null);

  // Show + track bounds. Re-runs on URL change so navigation just calls show
  // again with the new URL.
  //
  // Subtle: ResizeObserver fires SYNCHRONOUSLY when you start observing — the
  // initial entry reports the current size. We don't want that fire to race
  // with our deferred show call (it'd send setBounds before the webview
  // exists). The `hasShown` flag tracks whether we've called show at least
  // once; before that, RO entries are ignored.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let rafId = 0;
    let cancelled = false;
    let hasShown = false;
    let isHiddenForBounds = false;

    const dispatch = () => {
      if (cancelled) return;
      const r = host.getBoundingClientRect();
      // The host is "invisible" — either we haven't laid out yet, or the
      // user collapsed the right panel / shrunk it via drag. The native
      // webview is a top-level child of the main window and would otherwise
      // float over the rest of the app at its last bounds (showing as a
      // white rectangle covering the terminal grid). Hide it instead;
      // we'll re-show on the next valid bbox.
      if (r.width < 50 || r.height < 50) {
        if (hasShown && !isHiddenForBounds) {
          isHiddenForBounds = true;
          commands.webPreviewSetVisible(false).catch(() => {
            /* webview may have been closed already — ignore */
          });
        }
        return;
      }

      if (!hasShown) {
        hasShown = true;
        console.info("[WebPreview] show", { previewUrl, ...r.toJSON() });
        commands
          .webPreviewShow(previewUrl, r.x, r.y, r.width, r.height)
          .catch((err) => console.error("[WebPreview] show failed:", err));
      } else {
        if (isHiddenForBounds) {
          isHiddenForBounds = false;
          commands.webPreviewSetVisible(true).catch(() => {});
        }
        commands.webPreviewSetBounds(r.x, r.y, r.width, r.height).catch(() => {
          /* webview may have been closed concurrently — ignore */
        });
      }
    };

    // Defer first show until the host div has settled into layout.
    rafId = requestAnimationFrame(dispatch);

    // Track bounds. Coalesce with rAF so a splitter drag (which fires many
    // observer entries per second) only sends one setBounds per frame.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(dispatch);
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [previewUrl]);

  // Close the webview when the user leaves Browser mode (component unmounts).
  // Empty-deps effect — runs once, cleanup runs on unmount.
  useEffect(() => {
    return () => {
      commands.webPreviewClose().catch(() => {});
    };
  }, []);

  const commitUrl = (): string | null => {
    const trimmed = draft.trim();
    if (!trimmed) return null;

    const nextUrl = normalizeBrowserAddress(trimmed);
    setDraft(nextUrl);

    if (nextUrl !== url) setBrowserUrl(nextUrl);

    return nextUrl;
  };

  const handleRefresh = () => {
    // Re-show with the current URL — Rust calls navigate(url) on the existing
    // webview, which re-fetches the page (no eval needed).
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    const url = commitUrl() ?? previewUrl;
    commands
      .webPreviewShow(url, r.x, r.y, r.width, r.height)
      .catch((err) => console.warn("[WebPreview] refresh:", err));
  };

  const handleOpenInBrowser = async () => {
    try {
      await openUrl(commitUrl() ?? previewUrl);
    } catch (err) {
      console.warn("openUrl failed:", err);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1">
      {/* Address bar — bg-surface-2 + border-bottom so it's visually distinct
          from the segmented control above it. Without this, the dark URL row
          blends into the dark segmented-control row and reads as "no URL bar". */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3">
        <Globe className="h-3.5 w-3.5 text-fg-muted" />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitUrl();
              handleRefresh();
            }
          }}
          className={cn(
            "flex-1 rounded-md bg-surface-1 px-2 py-1 font-mono text-xs text-fg-primary",
            "outline-none focus:bg-surface-0",
            "placeholder:text-fg-muted",
          )}
          placeholder={DEFAULT_BROWSER_URL}
          spellCheck={false}
        />
        <PreviewButton
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          label="Refresh"
          onClick={handleRefresh}
        />
        <PreviewButton
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          label="Open in browser"
          onClick={handleOpenInBrowser}
        />
      </header>
      {/* The native webview is positioned by Rust to cover this div. The div
          itself paints a "loading / can't connect" hint in case the
          destination URL never paints (e.g. no dev server on the chosen
          port) — without this the user sees a blank white rectangle and
          can't tell whether the preview broke or the page just isn't there. */}
      <div
        ref={hostRef}
        className="relative flex-1 overflow-hidden bg-surface-0"
      >
        <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe className="h-6 w-6 text-fg-muted opacity-40" />
          <p className="text-xs text-fg-muted">
            Loading <span className="font-mono">{previewUrl}</span>…
          </p>
          <p className="text-[10px] text-fg-muted/60">
            If you see a blank page above this hint, the destination is offline
            or returned an empty response.
          </p>
        </div>
      </div>
    </section>
  );
}

function PreviewButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
    >
      {icon}
    </button>
  );
}
