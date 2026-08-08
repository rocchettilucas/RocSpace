import { describe, expect, it } from "vitest";
import {
  acceleratorChips,
  acceleratorFromEvent,
  appShortcutConflict,
  isDomOnlyAccelerator,
  matchesAccelerator,
  normalizeAccelerator,
  parseAccelerator,
} from "@/lib/accelerator";

/** A keydown, as the three readers here consume it. */
function key(
  code: string,
  mods: Partial<
    Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>
  > = {},
) {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("parseAccelerator", () => {
  it("reads the shape Rust wants", () => {
    expect(parseAccelerator("Alt+Space")).toEqual({
      modifiers: ["Alt"],
      key: "Space",
    });
    expect(parseAccelerator("Control+Shift+KeyR")).toEqual({
      modifiers: ["Control", "Shift"],
      key: "KeyR",
    });
  });

  it("resolves the spellings people actually use", () => {
    // Case, whitespace, the mac words for the modifiers, and the short key
    // names other apps' docs print.
    for (const spelling of [
      "alt+space",
      "  ALT + SPACE ",
      "Option+Space",
      "Opt+Space",
    ]) {
      expect(normalizeAccelerator(spelling)).toBe("Alt+Space");
    }
    expect(normalizeAccelerator("Cmd+Esc")).toBe("Super+Escape");
    expect(normalizeAccelerator("Meta+Up")).toBe("Super+ArrowUp");
    expect(normalizeAccelerator("Ctrl+/")).toBe("Control+Slash");
  });

  it("puts the modifiers in one order, so two spellings compare equal", () => {
    expect(normalizeAccelerator("Shift+Control+KeyR")).toBe(
      normalizeAccelerator("Control+Shift+KeyR"),
    );
    expect(normalizeAccelerator("Super+Alt+KeyR")).toBe("Alt+Super+KeyR");
  });

  it("refuses everything that is not a chord", () => {
    for (const bad of [
      "",
      "   ",
      "+",
      "Alt+",
      "+Space",
      "Alt++Space",
      "Alt+Nope",
      "Control+KeyA+KeyB",
      // Modifier after the key — the ordering rule global_hotkey enforces.
      "KeyA+Control",
      // A lone modifier is not a shortcut. This is exactly why macOS cannot
      // offer "hold Right Option" as the push-to-talk key.
      "Alt",
      "Super",
      // Repeated modifier: a typo, not a chord.
      "Alt+Alt+Space",
    ]) {
      expect(normalizeAccelerator(bad), bad).toBeNull();
    }
  });

  it("refuses a bare key that would eat itself, and allows the ones that cannot", () => {
    // Binding a bare Space globally takes the space bar away from every app on
    // the machine — including the field you would use to unbind it.
    expect(normalizeAccelerator("Space")).toBeNull();
    expect(normalizeAccelerator("KeyR")).toBeNull();

    // Function and media keys have no other job.
    expect(normalizeAccelerator("F13")).toBe("F13");
    expect(normalizeAccelerator("f24")).toBe("F24");
    expect(normalizeAccelerator("MediaPlayPause")).toBe("MediaPlayPause");
  });

  it("keeps a stored Caps Lock rather than rewriting it", () => {
    // It is the key RocTalk shipped with. Refusing it here rewrote the setting
    // of everyone who dictates with it to the default, on load, with nothing
    // said and no way to ask for it back.
    expect(normalizeAccelerator("CapsLock")).toBe("CapsLock");
    expect(normalizeAccelerator("capslock")).toBe("CapsLock");
  });
});

describe("isDomOnlyAccelerator", () => {
  it("names the keys the OS will not take", () => {
    // Bare Caps Lock is a choice the app can honour by listening for it, and
    // one the OS has no global mechanism for. The difference is what the
    // Settings row explains and what stops it being sent to `ptt_register`.
    expect(isDomOnlyAccelerator("CapsLock")).toBe(true);
    expect(isDomOnlyAccelerator("capslock")).toBe(true);

    // Anything the OS can be asked for is not this.
    for (const bindable of [
      "Alt+Space",
      "Control+CapsLock",
      "F13",
      "garbage",
    ]) {
      expect(isDomOnlyAccelerator(bindable), bindable).toBe(false);
    }
  });
});

describe("acceleratorFromEvent", () => {
  it("stays armed while only modifiers are held", () => {
    for (const code of ["AltLeft", "ShiftRight", "ControlLeft", "MetaLeft"]) {
      expect(acceleratorFromEvent(key(code, { altKey: true }))).toBe("pending");
    }
  });

  it("reads the chord off the keydown", () => {
    expect(acceleratorFromEvent(key("Space", { altKey: true }))).toBe(
      "Alt+Space",
    );
    expect(
      acceleratorFromEvent(
        key("KeyR", { ctrlKey: true, shiftKey: true, metaKey: true }),
      ),
    ).toBe("Control+Shift+Super+KeyR");
  });

  it("says no to a key the OS has no name for, and to a bare one", () => {
    // IntlBackslash is a real code and not one global_hotkey knows.
    expect(
      acceleratorFromEvent(key("IntlBackslash", { altKey: true })),
    ).toBeNull();
    expect(acceleratorFromEvent(key("Space"))).toBeNull();
    // …but a function key alone is fine.
    expect(acceleratorFromEvent(key("F13"))).toBe("F13");
  });

  it("captures bare Caps Lock, because the app can honour it", () => {
    // The picker refusing it left the person who dictates with Caps Lock
    // pressing the key they use and being told it is not a shortcut.
    expect(acceleratorFromEvent(key("CapsLock"))).toBe("CapsLock");
  });
});

describe("matchesAccelerator", () => {
  it("matches the chord it was given", () => {
    expect(
      matchesAccelerator(key("Space", { altKey: true }), "Alt+Space"),
    ).toBe(true);
    // Spelling of the stored value does not matter.
    expect(
      matchesAccelerator(key("Space", { altKey: true }), "option+space"),
    ).toBe(true);
  });

  it("does not match when an extra modifier is held", () => {
    // Alt+Space firing on Control+Alt+Space would be stealing somebody else's
    // shortcut while they are using it.
    expect(
      matchesAccelerator(
        key("Space", { altKey: true, ctrlKey: true }),
        "Alt+Space",
      ),
    ).toBe(false);
    expect(matchesAccelerator(key("Space"), "Alt+Space")).toBe(false);
    expect(
      matchesAccelerator(key("Enter", { altKey: true }), "Alt+Space"),
    ).toBe(false);
  });

  it("matches the bare Caps Lock the Windows hook uses", () => {
    // Never bound as an OS accelerator — `useRocTalk`'s DOM fallback asks about
    // it directly, on Windows because the keyboard hook delivers it, and
    // elsewhere because a user may have chosen it.
    expect(isDomOnlyAccelerator("CapsLock")).toBe(true);
    expect(matchesAccelerator(key("CapsLock"), "CapsLock")).toBe(true);
    expect(
      matchesAccelerator(key("CapsLock", { shiftKey: true }), "CapsLock"),
    ).toBe(false);
  });

  it("never matches a stored value that is not an accelerator", () => {
    expect(matchesAccelerator(key("Space", { altKey: true }), "garbage")).toBe(
      false,
    );
  });
});

describe("acceleratorChips", () => {
  it("labels the chord for the platform it is shown on", () => {
    expect(acceleratorChips("Alt+Space", { mac: true })).toEqual([
      "⌥",
      "Space",
    ]);
    expect(acceleratorChips("Alt+Space")).toEqual(["Alt", "Space"]);
    expect(acceleratorChips("Control+Shift+Super+KeyR", { mac: true })).toEqual(
      ["⌃", "⇧", "⌘", "R"],
    );
    expect(acceleratorChips("Alt+ArrowUp")).toEqual(["Alt", "↑"]);
    expect(acceleratorChips("Alt+Digit1")).toEqual(["Alt", "1"]);
    expect(acceleratorChips("Alt+Numpad5")).toEqual(["Alt", "Num 5"]);
  });

  it("shows a value it cannot read rather than nothing", () => {
    // A hand-edited settings file should not produce an empty control.
    expect(acceleratorChips("whatever")).toEqual(["whatever"]);
  });
});

describe("matchesAccelerator + parseAccelerator agree", () => {
  it("every key the picker can capture round-trips", () => {
    for (const code of ["KeyR", "Digit1", "Space", "Enter", "ArrowUp", "F5"]) {
      const captured = acceleratorFromEvent(key(code, { altKey: true }));
      expect(typeof captured, code).toBe("string");
      const accelerator = captured as string;
      expect(normalizeAccelerator(accelerator)).toBe(accelerator);
      expect(matchesAccelerator(key(code, { altKey: true }), accelerator)).toBe(
        true,
      );
    }
  });
});

describe("appShortcutConflict", () => {
  /** The picker validates against the OS's grammar and nothing else, so ⌘K is
   *  a legal push-to-talk key — and RocTalk hears it before the app does. The
   *  answer is a warning, not a refusal. */
  it("names what a chord would shadow", () => {
    expect(appShortcutConflict("Super+KeyK")).toMatch(/command palette/);
    expect(appShortcutConflict("Super+KeyW")).toMatch(/closes the focused/);
  });

  /** The bug this function is one typo away from at all times: the canonical
   *  modifier order is Control-Alt-Shift-Super, so a two-modifier chord spelled
   *  the way a person says it (⌘⇧M → "Super+Shift+KeyM") does not equal its own
   *  canonical form. A lookup that misses looks exactly like a chord that
   *  collides with nothing, which is the failure this whole function exists to
   *  prevent. Both spellings, one answer. */
  it("answers the same for either spelling of a two-modifier chord", () => {
    expect(appShortcutConflict("Super+Shift+KeyM")).toMatch(/RocMind/);
    expect(appShortcutConflict("Shift+Super+KeyM")).toMatch(/RocMind/);
    // …and that is what the picker actually produces.
    const captured = acceleratorFromEvent(
      key("KeyM", { metaKey: true, shiftKey: true }),
    ) as string;
    expect(appShortcutConflict(captured)).toMatch(/RocMind/);
  });

  it("says nothing about a chord the app does not bind", () => {
    expect(appShortcutConflict("Alt+Space")).toBeNull();
    expect(appShortcutConflict("Control+F13")).toBeNull();
    expect(appShortcutConflict("CapsLock")).toBeNull();
    // Not an accelerator at all.
    expect(appShortcutConflict("whatever")).toBeNull();
  });
});
