/** ⌘⇧K — and everything it deliberately stands down for. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useUIStore } from "@/stores/ui";
import { useGitShortcuts } from "@/views/RightPanel/useGitShortcuts";

/** Host for the hook — the listener is on the document, so nothing needs to be
 *  rendered for it to fire. */
function Host() {
  useGitShortcuts();
  return null;
}

const press = (init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, {
    key: "k",
    metaKey: true,
    shiftKey: true,
    ...init,
  });

const editor = () => useEditorStore.getState();

beforeEach(() => {
  useUIStore.setState({
    mainView: "terminals",
    isSettingsOpen: false,
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    taskEditor: null,
    gitDialog: null,
  });
  useEditorStore.setState({
    rightDockMode: "inspector",
    rightPanelCollapsed: true,
  });
  useGitStore.setState({ commitFocusNonce: 0 });
  // The focus tests below append real nodes; one left behind would still hold
  // the keyboard when the next test presses the chord.
  document.body.replaceChildren();
});

describe("⌘⇧K", () => {
  it("expands the panel, switches it to Git and asks for the commit box", () => {
    render(<Host />);

    press();

    expect(editor().rightPanelCollapsed).toBe(false);
    expect(editor().rightDockMode).toBe("git");
    expect(useGitStore.getState().commitFocusNonce).toBe(1);
  });

  it("is not ⌘K — that one belongs to the command palette", () => {
    render(<Host />);
    press({ shiftKey: false });
    expect(editor().rightDockMode).toBe("inspector");
  });

  it("ignores Ctrl-⇧K, which belongs to the shell in the pane", () => {
    render(<Host />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true, shiftKey: true });
    expect(editor().rightDockMode).toBe("inspector");
  });

  it("stands down under an open modal", () => {
    render(<Host />);
    useUIStore.setState({ isSettingsOpen: true });
    press();
    expect(editor().rightDockMode).toBe("inspector");
  });

  it("stands down in a text field, including the box it would focus", () => {
    render(<Host />);
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    press();

    expect(editor().rightDockMode).toBe("inspector");
    expect(useGitStore.getState().commitFocusNonce).toBe(0);
  });

  it("still fires from a focused terminal — that is where it is needed", () => {
    render(<Host />);
    // xterm's sink is a <textarea> that holds focus the whole time a pane is
    // focused; treating it as a text field would make the chord dead exactly
    // where somebody working in a pane would reach for it.
    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    document.body.appendChild(sink);
    sink.focus();

    press();

    expect(editor().rightDockMode).toBe("git");
  });
});
