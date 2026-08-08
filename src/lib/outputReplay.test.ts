/** Which of a session's retained bytes may be written into a fresh xterm.
 *
 *  The rule under test is one sentence: raw PTY bytes may be replayed whenever
 *  the screen they were written against can be re-established — from the start
 *  of the process's own stream, from the last full clear, or because the bytes
 *  never reach off the line they are on and so bring their own state with them.
 *  Only a stream that addresses the SCREEN with no known screen to address is
 *  shown as a transcript instead. Everything else in here is that sentence
 *  meeting the escape sequences a real agent CLI emits.
 */

import { describe, expect, it } from "vitest";
import type { TerminalOutputLine } from "@/lib/bindings";
import {
  flattenToTranscript,
  replayableOutput,
  RESTORED_NOTICE,
} from "@/lib/outputReplay";

const ESC = "\u001b";
const BEL = "\u0007";

let seq = 0;
const line = (text: string): TerminalOutputLine => ({
  id: `l${seq++}`,
  ts: seq,
  stream: "stdout",
  text,
});

/** `fromStreamStart` defaults to true — the ring still holds the first byte —
 *  because that is the case every short session is in. */
function replay(texts: string[], fromStreamStart = true): string {
  return replayableOutput(texts.map(line), { fromStreamStart });
}

/** What was written under the notice, for the flattened branch. */
const body = (out: string) => {
  expect(out.startsWith(RESTORED_NOTICE)).toBe(true);
  return out.slice(RESTORED_NOTICE.length);
};

describe("an untrimmed ring", () => {
  it("replays byte for byte", () => {
    // The stream starts where the process did, so a blank grid is exactly the
    // state these bytes were written against. Nothing may be second-guessed.
    expect(replay(["boot ", "banner"])).toBe("boot banner");
  });

  it("keeps the escape sequences intact", () => {
    const painted = `${ESC}[32mgreen${ESC}[0m\r\n${ESC}[2Kredrawn`;
    expect(replay([painted])).toBe(painted);
  });

  it("is not truncated at a clear it happens to contain", () => {
    // Nothing about these bytes can improve on them: they begin where the
    // process began, so the whole ring replays into a blank grid exactly as it
    // rendered live — including the scrollback above the clear, which the real
    // terminal also kept. The scan that used to run here answered a question
    // that was already settled, and cost a full pass over every pane's ring to
    // do it.
    const stream = `history${ESC}[2J${ESC}[Hfresh`;
    expect(replay([stream])).toBe(stream);
  });

  it("writes nothing for an empty ring", () => {
    expect(replay([])).toBe("");
    expect(replay(["", ""])).toBe("");
  });
});

describe("the last known-blank screen", () => {
  // A trimmed ring throughout: with the start of the stream gone, the anchor is
  // the only thing left that says what the screen held.
  it("replays from an erase of the whole display", () => {
    // Everything before the clear was erased on the real terminal too, so
    // dropping it is not a loss — writing it is the invention.
    const out = replay([`stale frame${ESC}[2J${ESC}[Hfresh frame`], false);
    expect(out).toBe(`${ESC}[2J${ESC}[Hfresh frame`);
  });

  it("takes the LAST one, not the first", () => {
    const out = replay(
      [`one${ESC}[2Jtwo${ESC}[3Jthree`, `${ESC}[2Jfour`, "five"],
      false,
    );
    expect(out).toBe(`${ESC}[2Jfourfive`);
  });

  it("recognizes a full reset", () => {
    expect(replay([`before${ESC}cafter`], false)).toBe(`${ESC}cafter`);
  });

  it("recognizes a switch to the alternate buffer", () => {
    // The alt buffer is blank on entry, and the switch itself has to be
    // replayed: the frames after it were painted into that buffer.
    const out = replay([`scrollback${ESC}[?1049h${ESC}[Hvim`], false);
    expect(out).toBe(`${ESC}[?1049h${ESC}[Hvim`);
  });

  it("ignores a partial erase", () => {
    // `ED 0` / `ED 1` / `EL` clear part of a screen whose rest still matters,
    // so none of them says anything about what the grid holds. Nothing here is
    // sliced at one — and nothing is flattened either, because erasing a region
    // is not addressing one.
    const stream = `keep${ESC}[0Jsome${ESC}[Kmore${ESC}[1Jrest`;
    expect(replay([stream], false)).toBe(stream);
  });

  it("is not fooled by an erase spelled inside a window title", () => {
    // An OSC payload is arbitrary text. Scanned two bytes at a time — or
    // backwards from the end, where there is no way to know a payload is what
    // you are in — a title holding "[2J" reads as a clear and throws the
    // session's history away.
    const stream = `real output${ESC}]0;a ${ESC}[2J title${BEL}more output`;
    expect(replay([stream], false)).toBe(stream);

    // …and the same title in a stream that IS flattened keeps its payload out
    // of the transcript, rather than slicing the stream at the fake clear.
    const addressed = `real output${ESC}]0;a ${ESC}[2J title${BEL}${ESC}[3;1Hmore`;
    expect(replay([addressed], false)).toBe(
      `${RESTORED_NOTICE}real outputmore`,
    );
  });

  it("applies even when the ring was trimmed", () => {
    // A trimmed ring is unsound only where it has no anchor. With one, the
    // anchor is the state — how much came before it does not matter.
    expect(replay([`lost${ESC}[2Jkept`], false)).toBe(`${ESC}[2Jkept`);
  });
});

describe("a trimmed ring that only rewrites its own line", () => {
  it("replays it verbatim, and says nothing", () => {
    // The shape of every long-running build: a progress bar redrawn with CR,
    // erased with EL, and never addressed by row. Replayed into a blank grid
    // it renders EXACTLY as it rendered live, each bar collapsed to its final
    // frame — so replaying it is not a guess and there is nothing to apologize
    // for. Flattening it here is what would do the damage: 332 lines of a
    // measured cargo build became 1992, and a thousand lines of real scrollback
    // went out the top to make room.
    const build = Array.from(
      { length: 40 },
      (_, i) => `\r${ESC}[KBuilding [${"=".repeat(i % 10)}>] ${i}%`,
    );
    const stream = [`   Compiling crate v0.1.0\r\n`, ...build, "\r\n"];

    const out = replay(stream, false);

    expect(out).toBe(stream.join(""));
    expect(out.startsWith(RESTORED_NOTICE)).toBe(false);
  });

  it("leaves a backspace to delete what it deleted", () => {
    // Flattened, this reads "Downloading 10%20%30%" — characters the process
    // took OFF the screen, put back by the code restoring it. Replayed, the
    // terminal applies the backspaces itself and shows "Downloading 30%",
    // which is what was there.
    const stream = "Downloading 10%\b\b\b20%\b\b\b30%";
    expect(replay([stream], false)).toBe(stream);
  });

  it("counts the line's own sequences as its own", () => {
    // Column moves, insertions and deletions within the line, and an erase of
    // part of the screen: reach ends at the line's two edges, or writes nothing
    // at all. A shell that redraws its prompt this way is still a shell whose
    // scrollback replays.
    for (const op of [
      `${ESC}[12G`, // CHA — a column, absolute but on this line
      `${ESC}[4X`, // ECH — erase characters
      `${ESC}[2@`, // ICH — insert characters
      `${ESC}[3P`, // DCH — delete characters
      `${ESC}[K`, // EL
      `${ESC}[0J`, // ED 0
      `${ESC}[?25l`, // hide the cursor
      `${ESC}[?2004h`, // bracketed paste on
      `${ESC}[1;32m`, // SGR
      `${ESC}]0;a title${BEL}`, // OSC
      `${ESC}[?1000r`, // XTRESTORE — private, not DECSTBM
    ]) {
      const stream = `before${op}after`;
      expect(replay([stream], false)).toBe(stream);
    }
  });
});

describe("a trimmed ring that addresses the screen", () => {
  it("says so, and shows the bytes as text", () => {
    const out = replay([`${ESC}[5;1Hplain output\r\n`], false);
    expect(out).toBe(`${RESTORED_NOTICE}plain output\n`);
  });

  it("does not composite two renders of the same line", () => {
    // The reported bug, in miniature: the CLI rewrote a line in place, so both
    // renders address the same row. Replayed into a blank grid the cursor-up
    // clamps at the top and the second render lands on the first — which is
    // the screenshot. Flattened, each render keeps its own line.
    const frames = `I'm Claude, an${ESC}[1A\rI'm Claude, an AI assistant made by Anthropic\r\n`;
    expect(body(replay([frames], false))).toBe(
      "I'm Claude, an\nI'm Claude, an AI assistant made by Anthropic\n",
    );
  });

  it("keeps colour and drops motion", () => {
    const out = body(
      replay(
        [`${ESC}[38;5;33mSonnet 5${ESC}[0m${ESC}[12;40H${ESC}[Kelsewhere`],
        false,
      ),
    );
    expect(out).toBe(`${ESC}[38;5;33mSonnet 5${ESC}[0melsewhere`);
  });

  it("writes nothing when the bytes were all escapes", () => {
    expect(replay([`${ESC}[2K${ESC}[1A${ESC}[?25l`], false)).toBe("");
  });

  it("knows every sequence that reaches off the line", () => {
    // Each of these lands bytes somewhere the replay cannot know the contents
    // of — a row above what was trimmed, a scrolling region, rows opened under
    // the rest of the screen, or the normal buffer this window never left.
    for (const op of [
      `${ESC}[1A`, // CUU
      `${ESC}[2B`, // CUD
      `${ESC}[3C`, // CUF
      `${ESC}[4D`, // CUB
      `${ESC}[1E`, // CNL
      `${ESC}[1F`, // CPL
      `${ESC}[7d`, // VPA
      `${ESC}[2e`, // VPR
      `${ESC}[3;9H`, // CUP
      `${ESC}[3;9f`, // HVP
      `${ESC}[2L`, // IL
      `${ESC}[2M`, // DL
      `${ESC}[1S`, // SU
      `${ESC}[1T`, // SD
      `${ESC}[2;30r`, // DECSTBM
      `${ESC}[s`, // SCOSC
      `${ESC}[u`, // SCORC
      `${ESC}7`, // DECSC
      `${ESC}8`, // DECRC
      `${ESC}M`, // RI
      `${ESC}[?1049l`, // leaving an alt buffer this window never entered
      `${ESC}[?47l`,
    ]) {
      const out = replay([`before${op}after`], false);
      expect(out, `${JSON.stringify(op)} should flatten`).toBe(
        `${RESTORED_NOTICE}beforeafter`,
      );
    }
  });
});

describe("flattening", () => {
  it("turns a bare carriage return into a line of its own", () => {
    // A bare CR is the overwrite: it returns to column 0 so the next bytes
    // replace the line. A spinner is hundreds of them.
    expect(flattenToTranscript("10%\r50%\r100%\r\ndone")).toBe(
      "10%\n50%\n100%\ndone",
    );
  });

  it("drops the control characters that move or erase", () => {
    expect(flattenToTranscript(`a\bb${BEL}cd`)).toBe("abcd");
  });

  it("keeps tabs and newlines", () => {
    expect(flattenToTranscript("a\tb\nc")).toBe("a\tb\nc");
  });

  it("drops an OSC whole, payload included", () => {
    expect(flattenToTranscript(`${ESC}]0;title with \\ and ;${BEL}after`)).toBe(
      "after",
    );
    expect(flattenToTranscript(`${ESC}]8;;https://x${ESC}\\after`)).toBe(
      "after",
    );
  });

  it("drops a device-control string whole", () => {
    expect(flattenToTranscript(`${ESC}Pq#0;2;0;0;0${ESC}\\after`)).toBe(
      "after",
    );
  });

  it("survives a sequence the ring cut in half", () => {
    // The ring trims by line, and a line can end mid-escape. A scanner that
    // ran off the end here would throw inside a mount effect.
    expect(flattenToTranscript(`text${ESC}[38;5;`)).toBe("text");
    expect(flattenToTranscript(`text${ESC}`)).toBe("text");
    expect(flattenToTranscript(`text${ESC}]0;unterminated`)).toBe("text");
  });
});
