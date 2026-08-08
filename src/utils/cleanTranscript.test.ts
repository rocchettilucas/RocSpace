import { describe, expect, it } from "vitest";
import { cleanTranscript } from "@/utils/cleanTranscript";

describe("cleanTranscript", () => {
  it("returns empty string unchanged", () => {
    expect(cleanTranscript("")).toBe("");
    expect(cleanTranscript("   ")).toBe("");
  });

  it("strips leading filler and capitalizes", () => {
    expect(cleanTranscript("um hello world")).toBe("Hello world. ");
  });

  it("strips standalone fillers anywhere in the string", () => {
    expect(cleanTranscript("hello uh world")).toBe("Hello world. ");
    expect(cleanTranscript("ah deploy er the app")).toBe("Deploy the app. ");
  });

  it("preserves 'like' and 'you know' (too many false positives in v1)", () => {
    expect(cleanTranscript("uh, like, deploy the app")).toBe(
      "Like, deploy the app. ",
    );
  });

  it("collapses runs of whitespace and strips comma stragglers around fillers", () => {
    expect(cleanTranscript("hello,    world")).toBe("Hello, world. ");
  });

  it("respects existing terminal punctuation (does not double up)", () => {
    expect(cleanTranscript("hello, world.")).toBe("Hello, world. ");
    expect(cleanTranscript("ready?")).toBe("Ready? ");
    expect(cleanTranscript("stop!")).toBe("Stop! ");
  });

  it("strips newlines so dictation never auto-submits a command", () => {
    expect(cleanTranscript("run\nrm -rf")).toBe("Run rm -rf. ");
    expect(cleanTranscript("a\r\nb")).toBe("A b. ");
  });

  it("is case-insensitive on filler matching but preserves casing elsewhere", () => {
    expect(cleanTranscript("Um the README is FYI only")).toBe(
      "The README is FYI only. ",
    );
  });

  it("handles fillers immediately followed by punctuation", () => {
    expect(cleanTranscript("uh, deploy the app")).toBe("Deploy the app. ");
    expect(cleanTranscript("hmm, that works")).toBe("That works. ");
  });

  it("does not turn fillers embedded in real words into garbage", () => {
    // 'hum' contains 'um' as substring but we only match whole words
    expect(cleanTranscript("hum a tune")).toBe("Hum a tune. ");
    // 'umbrella' contains 'um'
    expect(cleanTranscript("grab the umbrella")).toBe("Grab the umbrella. ");
  });

  it("returns empty when input is only fillers", () => {
    expect(cleanTranscript("um uh ah hmm")).toBe("");
  });
});
