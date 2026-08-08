import { useEffect, useSyncExternalStore } from "react";
import {
  fileContentsSnapshot,
  loadFile,
  subscribeFileContents,
  type FileContentsState,
} from "@/lib/fileContents";

/** Read a file for display, through the shared baseline cache.
 *
 *  The state itself lives in `@/lib/fileContents` rather than here, because a
 *  save, a revert and a reload-on-focus all change what this should be showing
 *  and none of them happens inside this component. `useSyncExternalStore` is
 *  what carries those back to the screen. */
export function useFileContents(
  projectRoot: string | null,
  path: string | null,
): FileContentsState {
  const state = useSyncExternalStore(subscribeFileContents, () =>
    fileContentsSnapshot(path),
  );

  useEffect(() => {
    if (!projectRoot || !path) return;
    void loadFile(projectRoot, path);
  }, [projectRoot, path]);

  if (!projectRoot || !path) return fileContentsSnapshot(null);
  return state;
}
