import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  clearTerminalRegistry,
  forEachTerminal,
  getTerminal,
  onTerminalRegistryChange,
  registerTerminal,
  unregisterTerminal,
} from "@/lib/terminalRegistry";

/** The registry only stores and hands back instances, so a stub is enough. */
function fakeTerminal(): Terminal {
  return { options: {} } as unknown as Terminal;
}

describe("terminalRegistry", () => {
  beforeEach(() => {
    clearTerminalRegistry();
  });

  it("registers, resolves and unregisters terminals by id", () => {
    const a = fakeTerminal();
    registerTerminal("a", a);
    expect(getTerminal("a")).toBe(a);

    unregisterTerminal("a");
    expect(getTerminal("a")).toBeUndefined();
  });

  it("visits every live terminal exactly once", () => {
    const a = fakeTerminal();
    const b = fakeTerminal();
    registerTerminal("a", a);
    registerTerminal("b", b);

    const seen = vi.fn();
    forEachTerminal(seen);

    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledWith("a", a);
    expect(seen).toHaveBeenCalledWith("b", b);
  });

  it("iterates a snapshot, so a callback may unregister while iterating", () => {
    registerTerminal("a", fakeTerminal());
    registerTerminal("b", fakeTerminal());

    const visited: string[] = [];
    expect(() =>
      forEachTerminal((id) => {
        visited.push(id);
        unregisterTerminal(id);
      }),
    ).not.toThrow();

    expect(visited).toEqual(["a", "b"]);
    forEachTerminal(() => expect.unreachable("registry should be empty"));
  });

  // Roc's live view watches a session whose card it does not own, and which may
  // not be mounted yet (another workspace, or a dock still being built).
  it("tells subscribers when the set of live terminals changes", () => {
    const heard = vi.fn();
    const unsubscribe = onTerminalRegistryChange(heard);

    registerTerminal("a", fakeTerminal());
    expect(heard).toHaveBeenCalledTimes(1);

    unregisterTerminal("a");
    expect(heard).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerTerminal("b", fakeTerminal());
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("says nothing when a call changes nothing", () => {
    const term = fakeTerminal();
    registerTerminal("a", term);

    const heard = vi.fn();
    onTerminalRegistryChange(heard);

    registerTerminal("a", term);
    unregisterTerminal("nobody");

    expect(heard).not.toHaveBeenCalled();
  });
});
