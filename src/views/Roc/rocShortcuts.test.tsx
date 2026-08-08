/** ⌘⇧R — and the ⌘R it deliberately does not take. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useRocStore } from "@/stores/roc";
import { useUIStore } from "@/stores/ui";
import { useRocShortcuts } from "@/views/Roc/useRocShortcuts";

/** Host for the hook — the listener is on the document, so nothing needs to be
 *  rendered for it to fire. */
function Host() {
  useRocShortcuts();
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key, metaKey: true, shiftKey: true, ...init });

const mainView = () => useUIStore.getState().mainView;

beforeEach(() => {
  useUIStore.setState({
    mainView: "terminals",
    isSettingsOpen: false,
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    taskEditor: null,
  });
  useRocStore.setState({ expanded: false });
});

describe("⌘⇧R", () => {
  it("swaps to Roc and back", () => {
    render(<Host />);

    press("r");
    expect(mainView()).toBe("roc");
    expect(useRocStore.getState().expanded).toBe(true);

    press("r");
    expect(mainView()).toBe("terminals");
    expect(useRocStore.getState().expanded).toBe(false);
  });

  // ⌘R is reload. Taking it would cost the user the app.
  it("is not ⌘R", () => {
    render(<Host />);

    fireEvent.keyDown(document, { key: "r", metaKey: true });

    expect(mainView()).toBe("terminals");
  });

  it("ignores Ctrl-⇧R — that key belongs to the shell in the pane", () => {
    render(<Host />);

    fireEvent.keyDown(document, { key: "r", ctrlKey: true, shiftKey: true });

    expect(mainView()).toBe("terminals");
  });

  it("stands down while Settings is open", () => {
    useUIStore.setState({ isSettingsOpen: true });
    render(<Host />);

    press("r");

    expect(mainView()).toBe("terminals");
  });

  it("stands down inside a text field", () => {
    render(<Host />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    press("r");

    expect(mainView()).toBe("terminals");
    field.remove();
  });

  // …except from inside Roc's own boxes, which are the ones the user is most
  // likely to be in when they want out.
  it("still fires from a text field inside the Roc view", () => {
    useUIStore.setState({ mainView: "roc" });
    useRocStore.setState({ expanded: true });
    render(<Host />);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();

    press("r");

    expect(mainView()).toBe("terminals");
    field.remove();
  });

  // Opening Roc from the board is fine; closing it must not land back there,
  // and must not be the board's own toggle.
  it("opens over the board and gives the terminals back", () => {
    useUIStore.setState({ mainView: "rocplan" });
    render(<Host />);

    press("r");
    expect(mainView()).toBe("roc");

    press("r");
    expect(mainView()).toBe("terminals");
  });
});
