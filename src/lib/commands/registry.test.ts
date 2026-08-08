/** The registry's two contracts: what an unregister takes back, and what
 *  happens when two registrations claim the same id. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allCommands,
  registerCommands,
  resetCommandRegistry,
  type CommandAction,
} from "@/lib/commands/registry";

const action = (id: string, title = id): CommandAction => ({
  id,
  title,
  group: "Workspace",
  run: () => {},
});

const ids = () => allCommands().map((c) => c.id);

beforeEach(() => {
  resetCommandRegistry();
});

describe("registerCommands", () => {
  it("starts empty and returns what was handed in, in order", () => {
    expect(allCommands()).toEqual([]);
    registerCommands([action("a"), action("b")]);
    registerCommands([action("c")]);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("unregister takes back only its own actions", () => {
    registerCommands([action("a")]);
    const drop = registerCommands([action("b"), action("c")]);
    registerCommands([action("d")]);

    drop();
    expect(ids()).toEqual(["a", "d"]);
  });

  it("unregister is idempotent — StrictMode double-invokes cleanups", () => {
    const dropFirst = registerCommands([action("a")]);
    const dropSecond = registerCommands([action("b")]);

    dropFirst();
    dropFirst();
    expect(ids()).toEqual(["b"]);

    dropSecond();
    expect(ids()).toEqual([]);
  });

  it("copies the array, so a caller mutating its own buffer changes nothing", () => {
    const buffer = [action("a")];
    registerCommands(buffer);
    buffer.push(action("b"));
    buffer.length = 0;

    expect(ids()).toEqual(["a"]);
  });
});

describe("allCommands de-duplication", () => {
  // Both halves matter: a re-registration (StrictMode, or a dependency change
  // while two registrations are briefly live) must contribute the FRESH
  // closure, and it must not move the row the user is aiming at.
  it("keeps the last registration of an id at the position it first appeared", () => {
    const stale = vi.fn();
    const fresh = vi.fn();

    registerCommands([{ ...action("switch"), run: stale }, action("zebra")]);
    registerCommands([{ ...action("switch"), run: fresh }]);

    expect(ids()).toEqual(["switch", "zebra"]);
    allCommands()[0]!.run();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("un-registering the newer copy leaves the older one live", () => {
    registerCommands([action("switch", "old")]);
    const drop = registerCommands([action("switch", "new")]);

    expect(allCommands()[0]!.title).toBe("new");
    drop();
    expect(allCommands()[0]!.title).toBe("old");
  });
});
