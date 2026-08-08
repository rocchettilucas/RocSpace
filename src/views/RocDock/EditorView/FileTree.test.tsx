/** The editor's file tree: what it does with a read that failed and then
 *  succeeded, and how anything created since it was drawn gets on screen. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import type { DirEntryDto } from "@/lib/bindings";
import { FileTree } from "@/views/RocDock/EditorView/FileTree";

const ROOT = "/code/rocspace";

const entry = (rel: string, isDir = false): DirEntryDto => ({
  name: rel.slice(rel.lastIndexOf("/") + 1),
  path: `${ROOT}/${rel}`,
  isDir,
  size: 1,
  hidden: false,
});

const refresh = () =>
  screen.getByRole("button", { name: "Refresh the file tree" });

beforeEach(() => {
  invoke.mockReset();
});

describe("FileTree", () => {
  it("stops showing a folder's error once the read succeeds", async () => {
    let failNext = true;
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      if (path === ROOT) return [entry("src", true)];
      if (failNext) {
        failNext = false;
        throw "read_dir failed: Permission denied";
      }
      return [entry("src/App.tsx")];
    });

    render(<FileTree projectRoot={ROOT} />);
    const folder = await screen.findByTitle(`${ROOT}/src`);

    await act(async () => {
      fireEvent.click(folder);
    });
    expect(await screen.findByText(/Permission denied/)).toBeVisible();

    // Collapsing and re-expanding retries, and the retry succeeds — but the
    // success path never cleared the error, and the error branch is checked
    // first, so the row won forever over the children behind it.
    await act(async () => {
      fireEvent.click(folder);
    });
    await act(async () => {
      fireEvent.click(folder);
    });

    expect(await screen.findByText("App.tsx")).toBeVisible();
    expect(screen.queryByText(/Permission denied/)).toBeNull();
  });

  it("re-reads the project when the user asks", async () => {
    let root = [entry("a.ts")];
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      return path === ROOT ? root : [];
    });

    render(<FileTree projectRoot={ROOT} />);
    expect(await screen.findByText("a.ts")).toBeVisible();

    // An agent wrote a file. There is no watcher here and no TTL: without a
    // way to ask, the only escape was switching the panel's mode away and back
    // to make the whole tree remount.
    root = [entry("a.ts"), entry("b.ts")];
    await act(async () => {
      fireEvent.click(refresh());
    });

    expect(await screen.findByText("b.ts")).toBeVisible();
  });

  it("re-reads a folder that is already open", async () => {
    let children = [entry("src/App.tsx")];
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      return path === ROOT ? [entry("src", true)] : children;
    });

    render(<FileTree projectRoot={ROOT} />);
    const folder = await screen.findByTitle(`${ROOT}/src`);
    await act(async () => {
      fireEvent.click(folder);
    });
    expect(await screen.findByText("App.tsx")).toBeVisible();

    // A child listing was cached for the life of the row, so the branch the
    // user is actually looking at was the one that could never change.
    children = [entry("src/App.tsx"), entry("src/New.tsx")];
    await act(async () => {
      fireEvent.click(refresh());
    });

    expect(await screen.findByText("New.tsx")).toBeVisible();
  });

  it("retries a root that could not be read", async () => {
    let broken = true;
    invoke.mockImplementation(async () => {
      if (broken) throw "read_dir failed: No such file or directory";
      return [entry("a.ts")];
    });

    render(<FileTree projectRoot={ROOT} />);
    expect(await screen.findByText(/No such file/)).toBeVisible();

    broken = false;
    await act(async () => {
      fireEvent.click(refresh());
    });

    expect(await screen.findByText("a.ts")).toBeVisible();
    expect(screen.queryByText(/No such file/)).toBeNull();
  });
});
