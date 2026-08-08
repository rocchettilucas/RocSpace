/** The running app's version, from the bundle rather than from a constant.
 *
 *  `getVersion()` reads what Tauri baked in at build time, which is the one
 *  number that cannot drift: a hardcoded string in the UI would keep claiming
 *  1.0.0 through every release that forgot to update it, and the topbar badge
 *  exists precisely so a user can tell which build they are looking at.
 *
 *  `null` until it resolves, and `null` forever without a Tauri runtime (plain
 *  `vite dev`, jsdom). Callers render nothing in that case rather than a
 *  placeholder — an empty space is honest, "v?" is not. */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // No runtime — the expected case outside the desktop app, and not
        // worth a warning on every mount of every surface that shows it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
