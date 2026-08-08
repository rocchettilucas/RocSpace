/** The predicates every key handler in the app asks before it fires. */

import { describe, expect, it } from "vitest";
import {
  isCodeEditorInput,
  isComposingKey,
  isTerminalInput,
  isTypingTarget,
} from "@/lib/dom";

describe("isTypingTarget", () => {
  it("stands down for a text field", () => {
    const input = document.createElement("input");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
  });

  it("does not stand down for a button, a checkbox, or nothing at all", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  // xterm's sink is a textarea and holds focus for most of the app's life.
  it("does not stand down for a focused terminal", () => {
    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    expect(isTerminalInput(sink)).toBe(true);
    expect(isTypingTarget(sink)).toBe(false);
  });
});

describe("isCodeEditorInput", () => {
  // Monaco's sink is a textarea too, so `isTypingTarget` says the same thing
  // about it as about a rename field — and ⌘S standing down there would make
  // save dead in the only place anyone presses it. This is what tells the two
  // apart; a chord that means something to the editor overrides on it.
  it("recognises anything inside a Monaco editor", () => {
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    const sink = document.createElement("textarea");
    sink.className = "inputarea monaco-mouse-cursor-text";
    editor.appendChild(sink);
    document.body.appendChild(editor);

    expect(isTypingTarget(sink)).toBe(true);
    expect(isCodeEditorInput(sink)).toBe(true);

    document.body.removeChild(editor);
  });

  it("says no to an ordinary field, a terminal, and nothing at all", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isCodeEditorInput(input)).toBe(false);
    document.body.removeChild(input);

    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    expect(isCodeEditorInput(sink)).toBe(false);
    expect(isCodeEditorInput(null)).toBe(false);
  });
});

describe("isComposingKey", () => {
  // The standard signal, as React hands it over: on the synthetic event's
  // native half.
  it("sees a composition on the synthetic event", () => {
    expect(isComposingKey({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isComposingKey({ nativeEvent: { isComposing: false } })).toBe(false);
  });

  it("sees one on a native event too", () => {
    expect(isComposingKey({ isComposing: true })).toBe(true);
  });

  // The legacy one. `isComposing` is false on the FIRST keydown of a
  // composition in some browsers, and 229 — "the IME is handling this" — is
  // what arrives instead. Dropping it would leave exactly the keystroke that
  // opens a composition unguarded.
  it("sees the legacy 229 the first keydown carries", () => {
    expect(isComposingKey({ keyCode: 229 })).toBe(true);
    expect(isComposingKey({ keyCode: 13 })).toBe(false);
  });

  it("says no to an ordinary Enter", () => {
    expect(
      isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 13 }),
    ).toBe(false);
    expect(isComposingKey({})).toBe(false);
  });
});
