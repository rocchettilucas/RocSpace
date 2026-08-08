/** What a freshly opened xterm may honestly be shown of a session's ring
 *  buffer.
 *
 *  The ring holds RAW PTY BYTES, and raw PTY bytes are not a document. They are
 *  one side of a conversation with a screen: `CUP` puts the cursor somewhere,
 *  `IL` opens a row, and the next run of text means "these cells now say this".
 *  Instructions like those are relative to a screen state the bytes do not
 *  carry. Replay them into a grid that was never in that state and they land on
 *  the wrong rows and overwrite each other — the reported symptom was two
 *  renders of the same Claude line in the same cells, one legible and one
 *  interleaved out of a dozen historical frames.
 *
 *  But that is a property of SOME streams, not of raw bytes as such, and the
 *  difference is the whole of this module. A stream whose every screen
 *  operation is confined to the line being written — `CR`, `LF`, `BS`, `EL`, a
 *  progress bar, a spinner, the ordinary output of every build tool — replays
 *  into a blank grid EXACTLY as it rendered the first time. It carries its own
 *  starting state, because each line starts where the bytes say it starts.
 *
 *  So the question is not "what did the session print" but "can these bytes be
 *  replayed and mean what they meant". Four answers, in the order they are
 *  asked:
 *
 *   1. **The ring still holds the start of the stream.** A process begins
 *      against a blank screen by definition, so an untrimmed ring is sound in
 *      full, whatever is in it. This is the case every fresh pane and every
 *      short session is in, and it is left byte-for-byte alone — no scan, no
 *      decision, nothing to get wrong.
 *   2. **The last anchor.** A sequence after which the screen's contents are
 *      known whatever preceded it: a full reset, an erase of the whole display,
 *      or a switch to the alternate buffer, which starts blank. Replaying from
 *      one is not an approximation — the terminal receives precisely the bytes
 *      it received the first time, from precisely the state it was in.
 *   3. **Neither, but nothing in the bytes reaches off its own line.** Verbatim
 *      is sound for the reason above, so verbatim is what it gets. Flattening
 *      here would be the damage, not the fix: it turns every frame of a `\r`
 *      progress bar into a line of its own (measured on a cargo build: 332
 *      lines of history become 1992) and resurrects characters the process
 *      deleted with `BS`.
 *   4. **Neither, and the bytes address the screen** — cursor motion off the
 *      line, a scrolling region, an insert or delete of rows, a return from the
 *      alternate buffer this window never entered. There is no sound replay, so
 *      the bytes stop being treated as screen operations and are flattened to
 *      what they say — colour and text, in order, one line per frame. That is
 *      not what the pane looked like, and it says so.
 *
 *  What this is NOT is a way to keep a live pane's screen. Nothing here runs on
 *  a workspace switch or a reshape any more: the dock keeps every pane's xterm
 *  alive across both (see `views/RocDock/PaneTree`), so the only caller left is
 *  a card's genuine first mount — a session hydrated from the boot snapshot
 *  above all, since `lib/persistence` writes the ring to disk with everything
 *  else. */

import type { TerminalOutputLine } from "@/lib/bindings";

const ESC = "\u001b";
/** BEL, which every shell uses in place of ST to terminate an OSC. */
const BEL = "\u0007";

/** The private modes that put the terminal on the alternate buffer, which is
 *  blank on entry: DECSET 47 (the original), 1047, and 1049 (the one every
 *  modern TUI uses — it saves the cursor and clears on the way in). */
const ALTERNATE_BUFFER_MODES = new Set(["47", "1047", "1049"]);

/** Written above a flattened tail, so a pane that comes back as a transcript
 *  reads as history rather than as a terminal that has gone wrong. Dim, and in
 *  the `[rocspace: …]` voice the output queue already uses for the bytes it
 *  had to drop. */
export const RESTORED_NOTICE = `${ESC}[2m[rocspace: restored from history]${ESC}[0m\r\n`;

/** How a session's retained output should be written into a terminal that has
 *  just opened.
 *
 *  `fromStreamStart` says the ring still holds the process's first byte — i.e.
 *  it has not been trimmed. The caller knows this and this module cannot: it is
 *  the difference between a sound full replay and a guess.
 *
 *  Returns "" when there is nothing worth writing. */
export function replayableOutput(
  lines: readonly TerminalOutputLine[],
  { fromStreamStart }: { fromStreamStart: boolean },
): string {
  const text = lines.map((line) => line.text).join("");
  if (text === "") return "";

  // Case 1, and it comes FIRST — before any scan. These bytes begin where the
  // process did, so no examination of them could change the answer, and the
  // scan they used to pay for was pure cost on the commonest path there is:
  // 64 panes' worth of it measured 187 ms of a mount's frame budget.
  if (fromStreamStart) return text;

  // One pass answers both remaining questions, because the second is only
  // asked when the first comes back empty and both have to look at everything
  // to be sure. Forward, and left to right: whether an ESC is a sequence at all
  // depends on what came before it — an OSC payload is arbitrary text, and a
  // window title holding "[2J" reads as an erase-the-screen anchor to anything
  // that starts in the middle and looks backwards.
  const { anchor, addressesScreen } = scanScreenOps(text);

  // Case 2, from the anchor INCLUSIVE: the sequence is what re-establishes the
  // state the rest was written against, and an alt-screen switch also has to be
  // replayed for the frames after it to land in the buffer they were painted
  // into.
  if (anchor !== null) return text.slice(anchor);

  // Case 3.
  if (!addressesScreen) return text;

  // Case 4.
  const transcript = flattenToTranscript(text);
  return transcript === "" ? "" : RESTORED_NOTICE + transcript;
}

// Escape-sequence scanning ---------------------------------------------------

type EscapeKind = "csi" | "osc" | "string" | "simple" | "lone";

interface EscapeToken {
  /** Index just past the sequence. */
  end: number;
  kind: EscapeKind;
  /** A CSI's parameter bytes (0x30–0x3F), e.g. `"?1049"` or `"2"`. */
  params: string;
  /** A CSI's or a two-byte escape's final character. */
  final: string;
}

const isParamByte = (ch: string) => ch >= "0" && ch <= "?";
const isIntermediateByte = (ch: string) => ch >= " " && ch <= "/";

/** Read the escape sequence beginning at `start`, where `text[start]` is ESC.
 *
 *  Total: an unterminated or truncated sequence returns the rest of the string,
 *  because the ring can be cut anywhere — including through an escape.
 *
 *  The string-payload kinds (OSC, DCS, APC, PM, SOS) are parsed to their
 *  terminator rather than skipped two bytes at a time for a reason that bites:
 *  a window title is arbitrary text, and a title containing `[2J` would
 *  otherwise read as an erase-the-screen anchor. */
function readEscape(text: string, start: number): EscapeToken {
  const introducer = text[start + 1];
  if (introducer === undefined) {
    return { end: start + 1, kind: "lone", params: "", final: "" };
  }

  if (introducer === "[") {
    let at = start + 2;
    while (at < text.length && isParamByte(text[at]!)) at++;
    const params = text.slice(start + 2, at);
    while (at < text.length && isIntermediateByte(text[at]!)) at++;
    const final = text[at] ?? "";
    return {
      end: final === "" ? at : at + 1,
      kind: "csi",
      params,
      final,
    };
  }

  if (introducer === "]") {
    let at = start + 2;
    while (at < text.length) {
      if (text[at] === BEL) return token("osc", at + 1);
      if (text[at] === ESC && text[at + 1] === "\\")
        return token("osc", at + 2);
      at++;
    }
    return token("osc", at);
  }

  if (
    introducer === "P" ||
    introducer === "_" ||
    introducer === "^" ||
    introducer === "X"
  ) {
    let at = start + 2;
    while (at < text.length) {
      if (text[at] === ESC && text[at + 1] === "\\") {
        return token("string", at + 2);
      }
      at++;
    }
    return token("string", at);
  }

  return { end: start + 2, kind: "simple", params: "", final: introducer };
}

const token = (kind: EscapeKind, end: number): EscapeToken => ({
  end,
  kind,
  params: "",
  final: "",
});

/** Whether the screen is known blank (or known restored to a known state) after
 *  this sequence, whatever came before it. */
function isBlankScreenAnchor({ kind, params, final }: EscapeToken): boolean {
  // RIS — a full reset of the terminal.
  if (kind === "simple") return final === "c";
  if (kind !== "csi") return false;

  // ED 2 / ED 3 — erase the whole display, and the scrollback with it. The
  // selective (`?`) form erases the same region.
  if (final === "J") {
    const mode = params.startsWith("?") ? params.slice(1) : params;
    return mode === "2" || mode === "3";
  }

  // DECSET of an alternate-buffer mode: the buffer being switched to is blank.
  if (final === "h" && params.startsWith("?")) {
    return params
      .slice(1)
      .split(";")
      .some((mode) => ALTERNATE_BUFFER_MODES.has(mode));
  }

  return false;
}

/** The CSI finals whose effect reaches OFF the line being written, and so out
 *  of the window being replayed.
 *
 *  This is the list that decides whether a trimmed ring is shown as a terminal
 *  or as a transcript, and what earns a place on it is one question: could this
 *  land bytes somewhere the replay does not know the contents of?
 *
 *    A B   CUU CUD    — up into rows that were trimmed away; down over rows the
 *                       real screen had and this one does not
 *    C D   CUF CUB    — the cursor is being driven rather than printed to, and
 *                       the columns it skips keep whatever the redraw left
 *    E F   CNL CPL    — the same, by whole lines
 *    d e   VPA VPR    — a row by number, which numbers nothing here
 *    H f   CUP HVP    — the plain statement of it: row and column, absolute
 *    L M   IL DL      — rows opened and closed under everything below them
 *    S T   SU SD      — the whole screen moved
 *    r     DECSTBM    — a scrolling region, imposed on rows this replay lacks
 *    s u   SCOSC SCORC— a cursor position saved before the window, restored in
 *                       it
 *
 *  Deliberately NOT here: everything whose reach ends at the line's own two
 *  edges — `CR`, `LF`, `BS`, `CHA`, `HPA`, `ICH`, `DCH`, `ECH`, `EL`, `REP` —
 *  and `ED 0` / `ED 1`, which erase a region of the screen rather than write
 *  into one. A stream made only of those replays into a blank grid EXACTLY as
 *  it rendered the first time, because every line it draws, it draws whole. */
const OFF_LINE_CSI_FINALS = new Set([
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "d",
  "e",
  "H",
  "f",
  "L",
  "M",
  "S",
  "T",
  "r",
  "s",
  "u",
]);

/** A CSI's parameters are private (`?`, `<`, `=`, `>`) — a different sequence
 *  wearing the same final byte. `CSI r` sets a scrolling region; `CSI ? … r`
 *  restores saved DEC modes and touches no cell. */
const hasPrivateParams = (params: string) =>
  params !== "" && params[0]! >= "<" && params[0]! <= "?";

/** Whether this sequence addresses the screen rather than the line — i.e.
 *  whether replaying it means anything without the rows that came before. */
function isOffLineScreenOp({ kind, params, final }: EscapeToken): boolean {
  // DECSC / DECRC, and RI, which scrolls the screen down at the top margin.
  if (kind === "simple") {
    return final === "7" || final === "8" || final === "M";
  }
  if (kind !== "csi") return false;

  if (hasPrivateParams(params)) {
    // DECRST of an alternate-buffer mode: a return to the normal buffer. It is
    // reached only with no anchor in the whole window, which means the matching
    // DECSET is not in the window either — so this leaves the terminal showing
    // a buffer nothing here ever painted.
    return (
      final === "l" &&
      params
        .slice(1)
        .split(";")
        .some((mode) => ALTERNATE_BUFFER_MODES.has(mode))
    );
  }

  return OFF_LINE_CSI_FINALS.has(final);
}

interface ScreenOpScan {
  /** Index of the START of the last sequence after which the screen's contents
   *  are known, or null when the stream holds none. */
  anchor: number | null;
  /** Whether any sequence in the stream reaches off the line it is on. */
  addressesScreen: boolean;
}

/** Both questions about a stream, in one pass.
 *
 *  `indexOf` rather than a character at a time: the gaps between escapes are
 *  plain text by definition, and skipping them natively is what keeps a full
 *  ring's scan in single-digit milliseconds. */
function scanScreenOps(text: string): ScreenOpScan {
  let anchor: number | null = null;
  let addressesScreen = false;
  let at = text.indexOf(ESC);
  while (at !== -1) {
    const escape = readEscape(text, at);
    if (isBlankScreenAnchor(escape)) anchor = at;
    else if (!addressesScreen && isOffLineScreenOp(escape)) {
      addressesScreen = true;
    }
    at = text.indexOf(ESC, escape.end);
  }
  return { anchor, addressesScreen };
}

// Flattening -----------------------------------------------------------------

/** The bytes as a transcript: what they said, in the order they said it, with
 *  everything that addresses the screen removed.
 *
 *  Kept: text, and SGR (`CSI … m`) — colour carries meaning and cannot move
 *  anything. Dropped: every other escape, and the control characters that
 *  reposition or erase.
 *
 *  A bare CR becomes a newline rather than being dropped. It is the sequence
 *  that returns to column 0 so the next bytes overwrite the line, which is
 *  exactly how a spinner or a redrawn input box composites frames on top of
 *  each other — the corruption in the report, in miniature. Giving each frame
 *  its own line is the honest rendering: repetitive, and never a lie about
 *  which characters were on screen together.
 *
 *  Repetitive is a real cost, which is why `replayableOutput` sends so little
 *  here: only a stream that addresses the screen, where the frames genuinely
 *  cannot be replayed into their own rows. A stream that only ever rewrites its
 *  own line is replayed instead, and keeps its final frames. */
export function flattenToTranscript(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const ch = text[at]!;

    if (ch === ESC) {
      const escape = readEscape(text, at);
      if (escape.kind === "csi" && escape.final === "m") {
        out += text.slice(at, escape.end);
      }
      at = escape.end;
      continue;
    }

    if (ch === "\r") {
      out += "\n";
      at += text[at + 1] === "\n" ? 2 : 1;
      continue;
    }

    // Everything else below 0x20 either moves the cursor (BS), rings a bell,
    // or switches character sets — none of which a transcript can honour.
    // `convertEol` makes a lone LF a full newline, so it is the one that stays.
    if (ch < " " && ch !== "\n" && ch !== "\t") {
      at++;
      continue;
    }

    out += ch;
    at++;
  }
  return out;
}
