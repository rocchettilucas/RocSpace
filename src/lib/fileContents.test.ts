/** The editor's baseline cache: what it believes is on disk, and how that
 *  belief is kept honest once the app itself starts writing. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  cachedFile,
  clearExternal,
  fileContentsSnapshot,
  forgetFile,
  loadFile,
  markSaved,
  peekExternal,
  putFile,
  readFromDisk,
  resetFileContents,
  stashExternal,
  subscribeFileContents,
} from "@/lib/fileContents";
import type { FileContentsDto } from "@/lib/bindings";

const ROOT = "/code/rocspace";
const PATH = `${ROOT}/src/App.tsx`;

const dto = (content: string, path = PATH): FileContentsDto => ({
  path,
  content,
  size: content.length,
  language: "typescript",
  writable: true,
});

beforeEach(() => {
  invoke.mockReset();
  resetFileContents();
});

describe("loadFile", () => {
  it("reads once and serves the cache afterwards", async () => {
    invoke.mockResolvedValue(dto("hello"));

    await loadFile(ROOT, PATH);
    await loadFile(ROOT, PATH);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(cachedFile(PATH)?.content).toBe("hello");
    expect(fileContentsSnapshot(PATH).status).toBe("ready");
  });

  it("collapses two concurrent reads of one file into one round trip", async () => {
    invoke.mockResolvedValue(dto("hello"));
    // Two mounted editors, or a focus check landing on a load in flight.
    await Promise.all([loadFile(ROOT, PATH), loadFile(ROOT, PATH)]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keys on the path asked for, not the one Rust answers with", async () => {
    // Rust canonicalizes; an entry filed under a spelling nothing looks up is
    // a tab that spins forever.
    invoke.mockResolvedValue(
      dto("hello", "/private/code/rocspace/src/App.tsx"),
    );
    await loadFile(ROOT, PATH);
    expect(cachedFile(PATH)?.content).toBe("hello");
  });

  it("records the refusal in Rust's own words", async () => {
    invoke.mockRejectedValue("path is outside the project root");
    await loadFile(ROOT, PATH);
    const snapshot = fileContentsSnapshot(PATH);
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("path is outside the project root");
    // A later successful read has to clear it, or the tab shows the old error
    // beside the new content.
    invoke.mockResolvedValue(dto("recovered"));
    forgetFile(PATH);
    await loadFile(ROOT, PATH);
    expect(fileContentsSnapshot(PATH).status).toBe("ready");
  });
});

describe("snapshots", () => {
  // `useSyncExternalStore` re-renders forever if an unchanged snapshot is a
  // new object each read. This is that contract, asserted.
  it("are referentially stable until the file changes", async () => {
    invoke.mockResolvedValue(dto("hello"));
    await loadFile(ROOT, PATH);

    const first = fileContentsSnapshot(PATH);
    expect(fileContentsSnapshot(PATH)).toBe(first);

    markSaved(PATH, "hello there");
    expect(fileContentsSnapshot(PATH)).not.toBe(first);
    expect(fileContentsSnapshot(PATH)).toBe(fileContentsSnapshot(PATH));
  });

  it("a null path is idle, not loading", () => {
    expect(fileContentsSnapshot(null).status).toBe("idle");
  });

  it("wake their subscribers", async () => {
    const listener = vi.fn();
    const stop = subscribeFileContents(listener);
    invoke.mockResolvedValue(dto("hello"));

    await loadFile(ROOT, PATH);
    expect(listener).toHaveBeenCalled();

    stop();
    listener.mockClear();
    markSaved(PATH, "changed");
    // A ⌘S from a collapsed panel must not reach a component that unmounted.
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("markSaved", () => {
  it("moves the baseline to the bytes just written", () => {
    putFile(PATH, dto("before"));
    markSaved(PATH, "after");
    expect(cachedFile(PATH)?.content).toBe("after");
  });

  it("measures the new size in BYTES, not characters", () => {
    putFile(PATH, dto("x"));
    markSaved(PATH, "café — ok");
    // 'é' is two bytes and '—' is three; a length-in-characters would under-
    // report, and the size is what the 5 MB cap is checked against.
    expect(cachedFile(PATH)?.size).toBe(
      new TextEncoder().encode("café — ok").length,
    );
  });

  it("is a no-op for a file nothing has read", () => {
    expect(() => markSaved("/nothing/here.ts", "x")).not.toThrow();
    expect(cachedFile("/nothing/here.ts")).toBeNull();
  });
});

describe("forgetFile", () => {
  it("drops the baseline so the next open re-reads", async () => {
    invoke.mockResolvedValue(dto("first"));
    await loadFile(ROOT, PATH);

    forgetFile(PATH);
    expect(cachedFile(PATH)).toBeNull();

    invoke.mockResolvedValue(dto("second"));
    await loadFile(ROOT, PATH);
    // The panes beside the editor write to these files. A tab reopened from a
    // session-long cache would show what the file said an hour ago.
    expect(cachedFile(PATH)?.content).toBe("second");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("takes the pending external change with it", () => {
    putFile(PATH, dto("mine"));
    stashExternal(PATH, dto("theirs"));
    forgetFile(PATH);
    expect(peekExternal(PATH)).toBeNull();
  });
});

describe("readFromDisk", () => {
  it("bypasses the cache and does NOT adopt what it finds", async () => {
    putFile(PATH, dto("baseline"));
    invoke.mockResolvedValue(dto("changed underneath"));

    const fresh = await readFromDisk(ROOT, PATH);

    expect(fresh.content).toBe("changed underneath");
    // What a difference MEANS is the caller's question — the answer may be a
    // dialog, and adopting it here would answer it for them.
    expect(cachedFile(PATH)?.content).toBe("baseline");
  });
});

describe("the external stash", () => {
  it("holds one file's disk content until it is answered", () => {
    stashExternal(PATH, dto("theirs"));
    expect(peekExternal(PATH)?.content).toBe("theirs");
    clearExternal(PATH);
    expect(peekExternal(PATH)).toBeNull();
  });
});
