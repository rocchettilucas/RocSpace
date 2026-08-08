/** ⌘⇧M — and the three things it has to refuse. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useUIStore } from "@/stores/ui";
import { useMindShortcuts } from "@/views/RocMind/useMindShortcuts";

function Harness() {
  useMindShortcuts();
  return (
    <div>
      <input aria-label="somewhere to type" />
    </div>
  );
}

const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document, {
    key,
    metaKey: true,
    shiftKey: true,
    ...init,
  });

const mainView = () => useUIStore.getState().mainView;

beforeEach(() => {
  useUIStore.setState({
    mainView: "terminals",
    isSettingsOpen: false,
    isCommandPaletteOpen: false,
  });
});

describe("⌘⇧M", () => {
  it("swaps the main area to RocMind and back to the terminals", () => {
    render(<Harness />);
    press("m");
    expect(mainView()).toBe("rocmind");
    press("m");
    expect(mainView()).toBe("terminals");
  });

  it("comes back to the terminals from RocMind even when the board was up", () => {
    // The same rule ⌘⇧P and ⌘⇧R follow: the dock is the way home from every
    // surface, so the chord does not need to be reasoned about.
    useUIStore.setState({ mainView: "rocplan" });
    render(<Harness />);
    press("m");
    expect(mainView()).toBe("rocmind");
    press("m");
    expect(mainView()).toBe("terminals");
  });

  it("stands down while a modal or Settings has the window", () => {
    useUIStore.setState({ isSettingsOpen: true });
    render(<Harness />);
    press("m");
    expect(mainView()).toBe("terminals");
  });

  it("leaves a bare ⌘M alone — it minimises the window", () => {
    render(<Harness />);
    press("m", { shiftKey: false });
    expect(mainView()).toBe("terminals");
  });

  it("does not fire from a text field, but still gets you out of RocMind", () => {
    // The view's own search box is a text field: a chord that stood down
    // inside it would make the way out unreachable from the box you are
    // typing in.
    const { getByLabelText } = render(<Harness />);
    const input = getByLabelText("somewhere to type");
    input.focus();

    press("m");
    expect(mainView()).toBe("terminals");

    useUIStore.setState({ mainView: "rocmind" });
    press("m");
    expect(mainView()).toBe("terminals");
  });
});
