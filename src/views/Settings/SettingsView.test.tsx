import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { confirmAction, resetConfirmState } from "@/stores/confirm";
import { DEFAULT_SETTINGS_SECTION, useUIStore } from "@/stores/ui";
import { ConfirmDialog } from "@/views/Workspaces/ConfirmDialog";
import { SettingsOverlay } from "@/views/Settings/SettingsView";

function openSettings() {
  useUIStore.setState({
    isSettingsOpen: true,
    settingsSection: DEFAULT_SETTINGS_SECTION,
  });
}

describe("SettingsOverlay", () => {
  beforeEach(() => {
    useUIStore.setState({
      isSettingsOpen: false,
      settingsSection: DEFAULT_SETTINGS_SECTION,
    });
  });

  it("renders nothing while Settings is closed", () => {
    render(<SettingsOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the section nav when opened via the store", () => {
    openSettings();
    render(<SettingsOverlay />);

    const nav = within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    );
    for (const label of [
      "Appearance",
      "Terminal",
      "Agents",
      "Notifications",
      "Voice",
      "Shortcuts",
      "About",
    ]) {
      expect(nav.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("switches section when a nav row is clicked", () => {
    openSettings();
    render(<SettingsOverlay />);
    const nav = within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    );

    fireEvent.click(nav.getByRole("button", { name: "Terminal" }));

    expect(useUIStore.getState().settingsSection).toBe("terminal");
    expect(nav.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: "Appearance" })).not.toHaveAttribute(
      "aria-current",
    );
    // The content pane follows the nav.
    expect(
      screen.getByRole("heading", { name: "Terminal", level: 3 }),
    ).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    openSettings();
    render(<SettingsOverlay />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });

  it("takes focus on open and hands it back on close", () => {
    // Without this the keyboard stays wherever it was — most often a focused
    // xterm, which swallows Escape and forwards it to the PTY as \x1b — and a
    // screen reader is left outside a dialog that just took over the view.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    openSettings();
    render(<SettingsOverlay />);

    const closeButton = screen.getByRole("button", { name: "Close settings" });
    expect(document.activeElement).toBe(closeButton);
    // A focus move, not a trap: the sidebar stays interactive by design.
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "false");

    fireEvent.click(closeButton);

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("does not chase focus to an element that left the DOM", () => {
    // The terminal that had focus can be closed while Settings is open.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    openSettings();
    render(<SettingsOverlay />);
    outside.remove();

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Close settings" })),
    ).not.toThrow();
  });

  it("leaves Escape to a focused text field instead of closing", () => {
    // Mid-edit in Default model, Escape means "back out of this field" — the
    // same thing it means in every other text input in the app. Taking the
    // whole overlay down instead is not what was pressed for.
    useUIStore.setState({ isSettingsOpen: true, settingsSection: "agents" });
    render(<SettingsOverlay />);

    const model = screen.getByLabelText("Default model");
    model.focus();
    expect(document.activeElement).toBe(model);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isSettingsOpen).toBe(true);
    // The press did step out of the field…
    expect(document.activeElement).not.toBe(model);
    // …so the next one closes, as it would have anywhere else.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });

  it("still closes on Escape from a non-text control", () => {
    // The guard is about text entry only — a focused button or radio has no
    // use for Escape, so the overlay keeps it.
    useUIStore.setState({ isSettingsOpen: true, settingsSection: "agents" });
    render(<SettingsOverlay />);

    screen.getByRole("radio", { name: /Skip all/ }).focus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });

  /** One Escape, one answer.
   *
   *  Settings › History asks "delete this saved session?" from inside the
   *  overlay, so the confirmation is ON TOP of Settings. Both listen for
   *  Escape on the document and neither used to ask whose turn it was, so one
   *  press answered "no" AND tore down the screen the question was asked from
   *  — the user loses their place for having declined. `ModalShell` already
   *  had the answer (`isTopmost`); this is the overlay learning to ask it. */
  it("leaves Escape to the dialog on top of it", async () => {
    openSettings();
    render(
      <>
        <SettingsOverlay />
        <ConfirmDialog />
      </>,
    );

    let answered: Promise<boolean>;
    act(() => {
      answered = confirmAction({
        title: "Delete saved session",
        message: "Delete the saved session “friday”?",
        confirmLabel: "Delete session",
        tone: "danger",
      });
    });
    await screen.findByRole("dialog", { name: "Delete saved session" });

    fireEvent.keyDown(document, { key: "Escape" });

    await expect(answered!).resolves.toBe(false);
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
    // …and the next press, with nothing on top any more, closes as it always
    // did — the guard is about order, not about disabling the key.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
    resetConfirmState();
  });

  it("closes on the header close button", () => {
    openSettings();
    render(<SettingsOverlay />);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(useUIStore.getState().isSettingsOpen).toBe(false);
  });
});
