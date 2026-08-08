/** The confirmation dialog itself: what it resolves to, and the rules that
 *  keep a destructive answer from being one stray keystroke away. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  confirmAction,
  isConfirmOpen,
  resetConfirmState,
  useConfirmStore,
} from "@/stores/confirm";
import { arePaneChordsBlocked, isAnyBlockingModalOpen } from "@/stores/ui";
import { ConfirmDialog } from "@/views/Workspaces/ConfirmDialog";
import { ModalShell } from "@/views/Workspaces/ModalShell";

const draft = {
  title: "Close pane",
  message: "Close “Rocky”? It is still running.",
  confirmLabel: "Close pane",
  tone: "danger" as const,
};

beforeEach(() => {
  resetConfirmState();
});

describe("ConfirmDialog", () => {
  it("shows nothing until something asks", () => {
    render(<ConfirmDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the question, and resolves true when confirmed", async () => {
    render(<ConfirmDialog />);
    const answer = confirmAction({ ...draft, detail: "The PTY is killed." });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Close “Rocky”/)).toBeInTheDocument();
    expect(screen.getByText("The PTY is killed.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    await expect(answer).resolves.toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("resolves false on Cancel, on the close button, and on Escape", async () => {
    render(<ConfirmDialog />);

    const cancelled = confirmAction(draft);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(cancelled).resolves.toBe(false);

    const closed = confirmAction(draft);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(closed).resolves.toBe(false);

    const escaped = confirmAction(draft);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(escaped).resolves.toBe(false);
  });

  // Focus lands on Cancel, and Enter still means yes — so a Return pressed
  // while reading must not silently answer "no" from the button that has it.
  it("opens focus on Cancel, and Enter confirms anyway", async () => {
    render(<ConfirmDialog />);
    const answer = confirmAction(draft);

    await screen.findByRole("dialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: "Enter" });
    await expect(answer).resolves.toBe(true);
  });

  // The save-collision shape: the name field sends on Enter, the collision
  // asks "replace it?" in the same tick, and the Return the user is STILL
  // holding autorepeats into the dialog that just appeared. A key that was
  // down before the question existed has not answered it.
  it("refuses an Enter that is an autorepeat of a key already held", async () => {
    render(<ConfirmDialog />);
    const answer = confirmAction({
      title: "Replace saved session",
      message: "Replace it?",
      confirmLabel: "Replace it",
      tone: "danger",
    });

    await screen.findByRole("dialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });

    fireEvent.keyDown(cancel, { key: "Enter", repeat: true });
    fireEvent.keyDown(cancel, { key: "Enter", repeat: true });
    // Still up, still unanswered — the assertion is that nothing happened, so
    // it has to be made against something that would have changed.
    expect(isConfirmOpen()).toBe(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // And a real press still answers, from the same element.
    fireEvent.keyDown(cancel, { key: "Enter" });
    await expect(answer).resolves.toBe(true);
  });

  // Scoped to the dialog, not to the document: the shell keeps focus inside,
  // so a keystroke from outside is aimed at a surface underneath and must not
  // be read as a yes to the question over it.
  it("ignores an Enter from outside the dialog", async () => {
    render(<ConfirmDialog />);
    const answer = confirmAction(draft);
    await screen.findByRole("dialog");

    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.keyDown(outside, { key: "Enter" });
    expect(isConfirmOpen()).toBe(true);
    outside.remove();

    useConfirmStore.getState().answer(false);
    await expect(answer).resolves.toBe(false);
  });

  it("uses the labels it was given", async () => {
    render(<ConfirmDialog />);
    const answer = confirmAction({
      title: "Replace saved session",
      message: "Replace it?",
      confirmLabel: "Replace it",
      cancelLabel: "Keep both",
    });

    expect(
      await screen.findByRole("button", { name: "Keep both" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace it" }));
    await expect(answer).resolves.toBe(true);
  });

  // Two dialogs the user cannot tell apart is worse than one question lost,
  // and the safe answer to a question nobody read is no.
  it("cancels an outstanding question when a second one is asked", async () => {
    render(<ConfirmDialog />);
    const first = confirmAction({ ...draft, title: "First" });
    const second = confirmAction({ ...draft, title: "Second" });

    await expect(first).resolves.toBe(false);
    expect(await screen.findByText("Second")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    await expect(second).resolves.toBe(true);
  });

  it("answers nothing when nothing is open", () => {
    expect(isConfirmOpen()).toBe(false);
    // Would throw or resolve a stale promise if `answer` did not check.
    useConfirmStore.getState().answer(true);
    expect(isConfirmOpen()).toBe(false);
  });
});

// A scrim stops the mouse, not the keyboard. The dialog lives in its own store
// (it carries a promise resolver), so the shared predicate has to ask it.
describe("the confirm dialog counts as a blocking modal", () => {
  it("blocks every chord while it is up", async () => {
    expect(isAnyBlockingModalOpen()).toBe(false);

    const answer = confirmAction(draft);
    expect(isAnyBlockingModalOpen()).toBe(true);
    expect(arePaneChordsBlocked()).toBe(true);

    useConfirmStore.getState().answer(false);
    await answer;
    expect(isAnyBlockingModalOpen()).toBe(false);
  });
});

// Confirmations are asked from INSIDE other dialogs — "Delete this card?" over
// the card editor. Both shells bind Escape and Tab on the document, so without
// a queue the outer one answers for the inner one.
describe("stacked dialogs", () => {
  it("Escape closes only the topmost dialog", async () => {
    const closeOuter = vi.fn();
    render(
      <>
        <ModalShell title="Card editor" onClose={closeOuter}>
          <p>body</p>
        </ModalShell>
        <ConfirmDialog />
      </>,
    );

    const answer = confirmAction(draft);
    await screen.findByText(/Close “Rocky”/);

    fireEvent.keyDown(document, { key: "Escape" });
    await expect(answer).resolves.toBe(false);
    expect(closeOuter).not.toHaveBeenCalled();

    // With the confirmation gone the editor answers Escape again.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(closeOuter).toHaveBeenCalledTimes(1));
  });
});
