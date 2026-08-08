import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "@/themes/registry";

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

const { useSettingsStore } = await import("@/stores/settings");
const { AppearanceSection } =
  await import("@/views/Settings/sections/AppearanceSection");

const otherTheme = THEMES.find((t) => t.id !== DEFAULT_THEME_ID)!;

describe("AppearanceSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({ themeId: DEFAULT_THEME_ID });
  });

  it("renders one card per registered theme, dark group first", () => {
    render(<AppearanceSection />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const cards = within(group).getAllByRole("radio");
    expect(cards).toHaveLength(THEMES.length);

    const order = cards.map((c) => c.dataset.themeCard);
    const firstLight = order.findIndex((id) => getTheme(id!).mode === "light");
    // Every light theme sorts after every dark one.
    expect(
      order.slice(firstLight).every((id) => getTheme(id!).mode === "light"),
    ).toBe(true);
  });

  it("marks the stored theme active and moves the pill on selection", () => {
    render(<AppearanceSection />);

    const activeCard = () =>
      screen
        .getAllByRole("radio")
        .find((c) => c.getAttribute("aria-checked") === "true");

    expect(activeCard()?.dataset.themeCard).toBe(DEFAULT_THEME_ID);
    expect(within(activeCard()!).getByText("Active")).toBeInTheDocument();

    fireEvent.click(
      screen
        .getAllByRole("radio")
        .find((c) => c.dataset.themeCard === otherTheme.id)!,
    );

    expect(useSettingsStore.getState().themeId).toBe(otherTheme.id);
    expect(activeCard()?.dataset.themeCard).toBe(otherTheme.id);
    // …and the theme is live on the document, not just in the store.
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      otherTheme.id,
    );
  });

  it("arrow keys move through the group and apply as they go", () => {
    render(<AppearanceSection />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const ids = within(group)
      .getAllByRole("radio")
      .map((c) => c.dataset.themeCard);

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(useSettingsStore.getState().themeId).toBe(ids[1]);

    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(useSettingsStore.getState().themeId).toBe(ids[0]);

    // Wraps to the last card rather than dead-ending.
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(useSettingsStore.getState().themeId).toBe(ids.at(-1));
  });

  it("paints each preview from that theme's own tokens", () => {
    render(<AppearanceSection />);

    const card = screen
      .getAllByRole("radio")
      .find((c) => c.dataset.themeCard === otherTheme.id)!;
    const preview = card.querySelector<HTMLElement>("[aria-hidden='true']")!;

    expect(preview.style.background).toBeTruthy();
    // jsdom normalizes colors, so compare through the same channel.
    const probe = document.createElement("div");
    probe.style.background = otherTheme.tokens.background;
    expect(preview.style.background).toBe(probe.style.background);
  });
});
