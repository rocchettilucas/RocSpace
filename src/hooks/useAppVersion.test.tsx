/** The version badge is the app's answer to "which build am I looking at?".
 *
 *  It is worth a test because both of its failure modes are silent: a badge
 *  that renders a hardcoded string keeps claiming the version it was written
 *  with, and a badge that renders before the runtime answers shows a shape the
 *  user has to interpret. Neither breaks a build. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAppVersion } from "@/hooks/useAppVersion";

const getVersion = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

function Probe() {
  const version = useAppVersion();
  return <span data-testid="v">{version ?? "(nothing)"}</span>;
}

afterEach(() => {
  getVersion.mockReset();
});

describe("useAppVersion", () => {
  it("reports what the bundle says, not a constant", async () => {
    // Deliberately not 1.0.0: a hook that hardcoded today's version would pass
    // a test written against today's version.
    getVersion.mockResolvedValue("9.4.2");
    render(<Probe />);

    await waitFor(() =>
      expect(screen.getByTestId("v").textContent).toBe("9.4.2"),
    );
  });

  it("renders nothing until the runtime answers", () => {
    getVersion.mockReturnValue(new Promise(() => {}));
    render(<Probe />);

    // Not "v?", not "v…" — an empty space is honest about not knowing yet.
    expect(screen.getByTestId("v").textContent).toBe("(nothing)");
  });

  it("stays quiet with no Tauri runtime at all", async () => {
    // A plain `vite dev` browser tab. The badge is absent rather than the
    // console filling with a rejection on every mount of every surface.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getVersion.mockRejectedValue(new Error("no ipc"));

    render(<Probe />);

    await vi.waitFor(() => expect(getVersion).toHaveBeenCalled());
    expect(screen.getByTestId("v").textContent).toBe("(nothing)");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
