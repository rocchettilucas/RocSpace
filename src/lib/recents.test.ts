import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetRecent,
  getRecents,
  onRecentsChanged,
  pruneRecents,
  rememberRecent,
  seedRecents,
} from "@/lib/recents";

const paths = () => getRecents().map((r) => r.path);

beforeEach(() => {
  seedRecents([]);
});

describe("pruneRecents", () => {
  it("drops the directories that no longer exist", async () => {
    seedRecents([
      { path: "/live", lastOpenedAt: 2 },
      { path: "/gone", lastOpenedAt: 1 },
    ]);

    await pruneRecents(async (p) => p === "/live");

    expect(paths()).toEqual(["/live"]);
  });

  it("announces once, and not at all when everything survived", async () => {
    const changed = vi.fn();
    const off = onRecentsChanged(changed);
    seedRecents([
      { path: "/a", lastOpenedAt: 2 },
      { path: "/b", lastOpenedAt: 1 },
    ]);

    await pruneRecents(async () => true);
    expect(changed).not.toHaveBeenCalled();

    await pruneRecents(async (p) => p === "/a");
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  /** A prune that has issued its IPC and not yet heard back, so a writer can
   *  land in between. */
  function gatedExists(dead: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pathExists = async (path: string) => {
      if (path !== dead) return true;
      await gate;
      return false;
    };
    return { pathExists, release: () => release() };
  }

  it("keeps a directory remembered while it was in flight", async () => {
    // The prune is one IPC round trip per remembered directory and runs off the
    // critical path at boot, so a workspace created in that window is the
    // normal case, not a rare one. Filtering a *snapshot* taken before the
    // await and assigning it back drops whatever landed meanwhile.
    seedRecents([
      { path: "/live", lastOpenedAt: 2 },
      { path: "/gone", lastOpenedAt: 1 },
    ]);
    const { pathExists, release } = gatedExists("/gone");

    const pruning = pruneRecents(pathExists);
    rememberRecent("/fresh");
    release();
    await pruning;

    expect(paths()).toEqual(["/fresh", "/live"]);
  });

  it("does not resurrect a directory forgotten while it was in flight", async () => {
    seedRecents([
      { path: "/live", lastOpenedAt: 2 },
      { path: "/gone", lastOpenedAt: 1 },
    ]);
    const { pathExists, release } = gatedExists("/gone");

    const pruning = pruneRecents(pathExists);
    forgetRecent("/live");
    release();
    await pruning;

    expect(paths()).toEqual([]);
  });

  it("re-sorts nothing and leaves an empty list alone", async () => {
    const changed = vi.fn();
    const off = onRecentsChanged(changed);

    await pruneRecents(async () => false);

    expect(paths()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    off();
  });
});
