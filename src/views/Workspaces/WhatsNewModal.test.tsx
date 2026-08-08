/** "What's new": when it announces itself, and what stops it doing so twice. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/** Settings writes are debounced; without a stand-in the timer fires into a
 *  missing Tauri runtime after the test has finished. */
vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    static async load(): Promise<FakeStore> {
      return new FakeStore();
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  }
  return { Store: FakeStore };
});

const { LATEST_ENTRY } = await import("@/lib/changelog");
const { useSettingsStore } = await import("@/stores/settings");
const { useUIStore } = await import("@/stores/ui");
const { WhatsNewModal, WhatsNewDialog } =
  await import("@/views/Workspaces/WhatsNewModal");

const entry = LATEST_ENTRY!;

beforeEach(() => {
  // `hydrated: true` is the state every test below except the two about
  // waiting is about: settings.dat has been read, and `whatsNewSeen` means
  // what it says.
  useSettingsStore.setState({ whatsNewSeen: "", hydrated: true });
  useUIStore.setState({ isWhatsNewOpen: false });
});

describe("WhatsNewModal", () => {
  it("announces the top changelog entry when it has not been read", () => {
    render(<WhatsNewModal />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(`What's new — ${entry.title}`)).toBeInTheDocument();
    // Its first bullet, not a summary of it — the file IS the copy.
    const firstItem = entry.sections[0]!.items[0]!;
    expect(screen.getByText(firstItem)).toBeInTheDocument();
  });

  // Boot, exactly as it happens: main.tsx races the settings read against
  // 250 ms and renders either way, so this mounts while `whatsNewSeen` is
  // still "" — which is indistinguishable from "never read it".
  const beforeTheReadLands = () => {
    useSettingsStore.setState({ whatsNewSeen: "", hydrated: false });
  };

  it("says nothing before the settings read has landed", () => {
    beforeTheReadLands();
    render(<WhatsNewModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // The failure this gate exists for: a reader who dismissed this entry
  // yesterday gets it again on every launch, because the answer arrived after
  // the question was asked.
  it("stays shut when the read lands saying it was already read", () => {
    beforeTheReadLands();
    render(<WhatsNewModal />);

    act(() =>
      useSettingsStore.setState({ whatsNewSeen: entry.id, hydrated: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("announces once the read lands and says it is unread", () => {
    beforeTheReadLands();
    render(<WhatsNewModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => useSettingsStore.setState({ hydrated: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("stays shut once that entry has been read", () => {
    useSettingsStore.setState({ whatsNewSeen: entry.id });
    render(<WhatsNewModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // An older acknowledgement is what an upgrade looks like from here.
  it("announces again when the changelog has moved on", () => {
    useSettingsStore.setState({ whatsNewSeen: "phase-1" });
    render(<WhatsNewModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closing it is the acknowledgement", () => {
    render(<WhatsNewModal />);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(useSettingsStore.getState().whatsNewSeen).toBe(entry.id);
    expect(useUIStore.getState().isWhatsNewOpen).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape closes it, and still counts as read", () => {
    render(<WhatsNewModal />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useSettingsStore.getState().whatsNewSeen).toBe(entry.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // The palette action and Settings › About both go through the store flag.
  it("reopens on request even after it has been read", () => {
    useSettingsStore.setState({ whatsNewSeen: entry.id });
    render(<WhatsNewModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => useUIStore.getState().openWhatsNew());
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("counts as a blocking modal while it is up", () => {
    render(<WhatsNewModal />);
    expect(useUIStore.getState().isWhatsNewOpen).toBe(true);
  });
});

describe("WhatsNewDialog", () => {
  it("renders every section of the entry it is given", () => {
    render(
      <WhatsNewDialog
        entry={{
          id: "test",
          title: "A Release",
          date: "2026-08-05",
          lead: ["a lead line"],
          sections: [
            { heading: "Added", items: ["one", "two"] },
            { heading: "Fixed", items: ["three"] },
          ],
        }}
      />,
    );

    expect(screen.getByText("2026-08-05")).toBeInTheDocument();
    expect(screen.getByText("a lead line")).toBeInTheDocument();
    for (const text of ["Added", "one", "two", "Fixed", "three"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("falls back to a bare title when the entry has none", () => {
    render(
      <WhatsNewDialog
        entry={{ id: "x", title: "", date: null, lead: [], sections: [] }}
      />,
    );
    expect(screen.getByText("What's new")).toBeInTheDocument();
  });
});
