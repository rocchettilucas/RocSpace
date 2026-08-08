import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { useSettingsStore } from "@/stores/settings";
import { applyTheme } from "@/themes/apply";
import { DEFAULT_THEME_ID } from "@/themes/registry";

/** How long first paint may wait for `settings.dat`.
 *
 *  The read takes a couple of milliseconds under Tauri, so this only bites when
 *  the store plugin is absent or hung — plain `vite dev` in a browser, a locked
 *  file. Then we paint the default rather than hold a blank window: one frame
 *  of the wrong theme beats no window at all. */
const HYDRATE_TIMEOUT_MS = 250;

// Theme before paint. The default lands synchronously (it matches the `--rs-*`
// values compiled into styles.css, so it is visually a no-op), then we wait —
// briefly — for the persisted choice. Gating App is not enough: <html> paints
// its own background the moment the document renders, so kicking hydration off
// and rendering immediately flashes the dark default on every launch for anyone
// running a light theme.
applyTheme(DEFAULT_THEME_ID);

const hydrated = Promise.race([
  useSettingsStore.getState().hydrate(),
  new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_TIMEOUT_MS)),
]);

void hydrated
  .catch((err: unknown) => console.warn("[main] theme hydration failed:", err))
  .then(() => {
    // StrictMode double-invokes useLayoutEffect setup+cleanup in development,
    // which causes react-resizable-panels v4's forceRerender mechanism to
    // exceed React 19's 50-render limit. Removed for compatibility; re-enable
    // once upstream fixes land.
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <App />,
    );
  });
