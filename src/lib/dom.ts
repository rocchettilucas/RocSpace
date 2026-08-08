/** Small DOM predicates shared by anything that binds a global key.
 *
 *  App-level shortcuts have to answer one question before they fire: is the
 *  user typing? Getting it wrong either swallows a character mid-rename or lets
 *  ⌘W close a pane out from under someone who meant to close a word. */

/** `<input>` types that hold no text — a key pressed in one of them means
 *  whatever the app says it means. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Is the user typing into this element? */
export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

/** xterm's hidden input sink.
 *
 *  It is a `<textarea>`, so `isTextEntry` says yes — and it holds focus for the
 *  entire time a terminal is focused, which is most of the time anyone is using
 *  RocSpace. Treating it as a text field would make every pane shortcut dead
 *  exactly where panes are being used. Shortcuts that fire here must claim the
 *  event (`preventDefault`) so the keystroke does not also go down the PTY. */
export function isTerminalInput(el: Element | null): boolean {
  return (
    el instanceof HTMLElement && el.classList.contains("xterm-helper-textarea")
  );
}

/** Should an app-level shortcut stand down for this element? True for real text
 *  fields, false for a focused terminal. */
export function isTypingTarget(el: Element | null): boolean {
  return isTextEntry(el) && !isTerminalInput(el);
}

/** Monaco's hidden input sink, or anything else inside a code editor.
 *
 *  The same shape of problem as xterm's: it is a `<textarea>`, so `isTextEntry`
 *  says yes, and it holds focus for the whole time the editor is focused. But
 *  the answer is not the same. A terminal shortcut has to fire there because
 *  the terminal is what it acts on; ⌘S has to fire there because the editor is
 *  what it acts on, and standing down would make save dead in the one place
 *  anyone ever presses it. So a chord that means something to the EDITOR asks
 *  this and overrides `isTypingTarget`; every other chord leaves it alone and
 *  stays out of a field somebody is typing in.
 *
 *  Matched on the container rather than on the textarea's class because the
 *  focus may sit on the editor's own widgets (find box, suggest list) too, and
 *  they are all inside `.monaco-editor`. */
export function isCodeEditorInput(el: Element | null): boolean {
  return el instanceof HTMLElement && el.closest(".monaco-editor") !== null;
}

/** Is this key press part of an IME composition?
 *
 *  A composer that submits on Enter has to ask. Typing Japanese, Chinese or
 *  Korean means typing a draft into the IME and pressing Enter to ACCEPT it —
 *  the Enter that commits 「テスト」 is not the Enter that sends the message, and
 *  a box that cannot tell them apart fires off half a word to an agent every
 *  time somebody composes one. It is the same reason xterm and every chat
 *  client in the world check this.
 *
 *  Both signals, because neither is enough on its own: `isComposing` is the
 *  standard one and is false on the very first keydown of a composition in some
 *  browsers, where the legacy `keyCode === 229` ("the IME is handling this")
 *  is what shows up instead. */
export function isComposingKey(e: {
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return (
    e.nativeEvent?.isComposing === true ||
    e.isComposing === true ||
    e.keyCode === 229
  );
}
