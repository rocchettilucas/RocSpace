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

const { DEFAULT_TERMINAL_SETTINGS, useSettingsStore } =
  await import("@/stores/settings");
const { TerminalSection } =
  await import("@/views/Settings/sections/TerminalSection");

describe("TerminalSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      terminal: { ...DEFAULT_TERMINAL_SETTINGS },
    });
  });

  it("steps the font size and stops at the bounds", () => {
    render(<TerminalSection />);
    const stepper = screen.getByRole("group", { name: "Terminal font size" });
    const inc = screen.getByRole("button", {
      name: "Increase terminal font size",
    });
    const dec = screen.getByRole("button", {
      name: "Decrease terminal font size",
    });

    fireEvent.click(inc);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(14);
    expect(stepper).toHaveTextContent("14px");

    fireEvent.click(dec);
    fireEvent.click(dec);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(12);

    act(() => {
      useSettingsStore.setState({
        terminal: { fontSize: 20, scrollback: 5000 },
      });
    });
    expect(inc).toBeDisabled();
    act(() => {
      useSettingsStore.setState({
        terminal: { fontSize: 10, scrollback: 5000 },
      });
    });
    expect(dec).toBeDisabled();
  });

  it("picks a scrollback preset", () => {
    render(<TerminalSection />);
    const select = screen.getByLabelText("Scrollback");

    fireEvent.change(select, { target: { value: "10000" } });

    expect(useSettingsStore.getState().terminal.scrollback).toBe(10000);
  });

  it("keeps a persisted value that is not one of today's presets", () => {
    useSettingsStore.setState({ terminal: { fontSize: 13, scrollback: 3000 } });
    render(<TerminalSection />);

    const select = screen.getByLabelText<HTMLSelectElement>("Scrollback");
    expect(select.value).toBe("3000");
    expect(
      screen.getByRole("option", { name: "3,000 lines" }),
    ).toBeInTheDocument();
  });
});
