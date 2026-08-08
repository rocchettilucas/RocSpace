import { beforeEach, describe, expect, it } from "vitest";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { parseRocCommand, resolveTargets } from "@/lib/rocTargets";
import { useRocStore } from "@/stores/roc";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

describe("parseRocCommand", () => {
  it("lifts leading @names off the front of the message", () => {
    expect(parseRocCommand("@Rocky @Roxie fix the test")).toEqual({
      text: "fix the test",
      explicitNames: ["Rocky", "Roxie"],
      broadcast: false,
    });
  });

  it("takes a token from the middle of a sentence too", () => {
    expect(parseRocCommand("ask @Rocky about the flake")).toEqual({
      text: "ask about the flake",
      explicitNames: ["Rocky"],
      broadcast: false,
    });
  });

  it.each(["@all deploy", "@everyone deploy", "@ALL deploy"])(
    "treats %s as a broadcast",
    (input) => {
      expect(parseRocCommand(input)).toEqual({
        text: "deploy",
        explicitNames: [],
        broadcast: true,
      });
    },
  );

  // A broadcast is the one target list nobody can take back, and the name class
  // stops at a dot — so "@all.com" and "@everyone." both used to mean everybody.
  // An alias has to be the whole token; anything that keeps going is an address
  // and is left in the message exactly as typed.
  it.each([
    "the domain is @all.com",
    "read @everyone.txt first",
    "@all.com",
    "tell @everyone.",
    "@all/deploy",
  ])("does not broadcast %s", (input) => {
    expect(parseRocCommand(input)).toEqual({
      text: input,
      explicitNames: [],
      broadcast: false,
    });
  });

  // …and the punctuation that ends a sentence is not a token continuing.
  it.each(["@all, ship it", "(@all) ship it", "@everyone! ship it"])(
    "still broadcasts %s",
    (input) => {
      expect(parseRocCommand(input).broadcast).toBe(true);
    },
  );

  // "everybody as well as Rocky" is still everybody, and a dispatch that went
  // to one pane twice would paste the message twice.
  it("lets a broadcast swallow the names beside it", () => {
    expect(parseRocCommand("@all @Rocky ship it")).toEqual({
      text: "ship it",
      explicitNames: [],
      broadcast: true,
    });
  });

  // The one that has to be right: an address is not a mention. `lucas@x.com`
  // has an `@` in the middle of a word, and a parser that took it would send
  // the message to a pane called "x.com" — or to nobody, silently.
  it("leaves an email address alone", () => {
    expect(parseRocCommand("mail the log to dev@example.com please")).toEqual({
      text: "mail the log to dev@example.com please",
      explicitNames: [],
      broadcast: false,
    });
  });

  // The boundary bug, one probe per shape. Every one of these used to parse as
  // NO mention at all — the name stayed in the message and the dispatch fell
  // through to whoever happened to be focused, with nothing in the unknown list
  // for the UI to warn about. A name addressed and silently ignored is the one
  // failure this parser exists to prevent.
  it.each([
    ["(@Rocky) restart", "() restart"],
    ["—@Rocky restart", "— restart"],
    ["path/@Rocky restart", "path/ restart"],
    ["[@Rocky] restart", "[] restart"],
    ["'@Rocky' restart", "'' restart"],
  ])("takes the name in %s", (input, text) => {
    expect(parseRocCommand(input)).toEqual({
      text,
      explicitNames: ["Rocky"],
      broadcast: false,
    });
  });

  // Two names with nothing between them. The second `@` touches a word
  // character — the tail of the first name — and the only thing that tells it
  // apart from the middle of an email address is that the word it touches is a
  // mention this same pass just took.
  it("parses @tokens written back to back", () => {
    expect(parseRocCommand("@rocky@roxie ship it")).toEqual({
      text: "ship it",
      explicitNames: ["rocky", "roxie"],
      broadcast: false,
    });
  });

  // …and the same shape with an unknown name still reports it, rather than
  // dropping it into the message.
  it("keeps a mention-shaped name it cannot place, whatever it was written against", () => {
    expect(parseRocCommand("(@Ghost) hello").explicitNames).toEqual(["Ghost"]);
    expect(parseRocCommand("cc @Rocky@Ghost").explicitNames).toEqual([
      "Rocky",
      "Ghost",
    ]);
  });

  // The reason the old boundary was strict. Loosening it must not loosen this:
  // an `@` against a word character is punctuation inside an address.
  it.each([
    "mail the log to dev@example.com please",
    "ping rocky@example.org about it",
    "a@b@c is not three mentions",
  ])("leaves %s alone", (input) => {
    expect(parseRocCommand(input)).toEqual({
      text: input,
      explicitNames: [],
      broadcast: false,
    });
  });

  it("is not fooled by a bare @ or a lone punctuation mark", () => {
    expect(parseRocCommand("what does @ even do")).toEqual({
      text: "what does @ even do",
      explicitNames: [],
      broadcast: false,
    });
  });

  it("keeps the punctuation that followed a name", () => {
    expect(parseRocCommand("@Rocky, are you there?")).toEqual({
      text: ", are you there?",
      explicitNames: ["Rocky"],
      broadcast: false,
    });
  });

  it("names one pane once, however many times it was typed", () => {
    expect(parseRocCommand("@Rocky @rocky @ROCKY go")).toEqual({
      text: "go",
      explicitNames: ["Rocky"],
      broadcast: false,
    });
  });

  it("keeps an unknown name as typed — resolving is somebody else's job", () => {
    expect(parseRocCommand("@Nobody hello")).toEqual({
      text: "hello",
      explicitNames: ["Nobody"],
      broadcast: false,
    });
  });

  it("survives a message that is nothing but tokens", () => {
    expect(parseRocCommand("  @Rocky  ")).toEqual({
      text: "",
      explicitNames: ["Rocky"],
      broadcast: false,
    });
  });
});

// ---------------------------------------------------------------------------

/** Two workspaces: "front" holds Rocky + Roxie, "back" holds Rocco. Front is
 *  active. */
function seed() {
  const front = newWorkspace({ projectPath: "/front", order: 0 });
  const back = newWorkspace({ projectPath: "/back", order: 1 });
  const make = (workspaceId: string, name: string) =>
    newTerminal({
      workspaceId,
      name,
      agentType: "shell",
      projectPath: "/tmp",
    });
  const rocky = make(front.id, "Rocky");
  const roxie = make(front.id, "Roxie");
  const rocco = make(back.id, "Rocco");
  useTerminalsStore.getState().setTerminals([rocky, roxie, rocco]);
  useWorkspacesStore.setState({
    workspaces: [
      {
        ...front,
        paneTree: {
          kind: "split",
          direction: "row",
          ratio: 0.5,
          first: { kind: "leaf", terminalId: rocky.id },
          second: { kind: "leaf", terminalId: roxie.id },
        },
      },
      { ...back, paneTree: { kind: "leaf", terminalId: rocco.id } },
    ],
    activeWorkspaceId: front.id,
  });
  return { front, back, rocky, roxie, rocco };
}

const names = (targets: { name: string }[]) => targets.map((t) => t.name);

beforeEach(() => {
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null });
  useRocStore.setState({ focusedRailTerminalId: null });
});

describe("resolveTargets", () => {
  const opts = { selectedIds: [] as string[], activeWorkspaceOnly: false };

  it("matches names case-insensitively", () => {
    const { rocky } = seed();
    const { targets, unknown } = resolveTargets(
      parseRocCommand("@rocky go"),
      opts,
    );

    expect(targets).toEqual([
      { terminalId: rocky.id, name: "Rocky", workspaceId: rocky.workspaceId },
    ]);
    expect(unknown).toEqual([]);
  });

  it("reaches into another workspace unless told not to", () => {
    seed();

    expect(names(resolveTargets(parseRocCommand("@Rocco go"), opts).targets)) //
      .toEqual(["Rocco"]);

    const scoped = resolveTargets(parseRocCommand("@Rocco go"), {
      ...opts,
      activeWorkspaceOnly: true,
    });
    expect(scoped.targets).toEqual([]);
    expect(scoped.unknown).toEqual(["Rocco"]);
  });

  it("hands back the names it could not place, as typed", () => {
    seed();
    const { targets, unknown } = resolveTargets(
      parseRocCommand("@Rocky @Ghost go"),
      opts,
    );

    expect(names(targets)).toEqual(["Rocky"]);
    expect(unknown).toEqual(["Ghost"]);
  });

  // Broadcast is the ACTIVE workspace, not the world: "@all" said while looking
  // at one project should not reach into another one the user forgot was open.
  it("broadcasts to every pane in the active workspace, and no further", () => {
    seed();
    const { targets } = resolveTargets(parseRocCommand("@all ship"), opts);

    expect(names(targets)).toEqual(["Rocky", "Roxie"]);
  });

  it("puts a broadcast in the dock's own order", () => {
    const { front, rocky, roxie } = seed();
    // Swap the tree round; the answer must follow the panes, not the ids.
    useWorkspacesStore.setState((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === front.id
          ? {
              ...w,
              paneTree: {
                kind: "split" as const,
                direction: "row" as const,
                ratio: 0.5,
                first: { kind: "leaf" as const, terminalId: roxie.id },
                second: { kind: "leaf" as const, terminalId: rocky.id },
              },
            }
          : w,
      ),
    }));

    const { targets } = resolveTargets(parseRocCommand("@all ship"), opts);
    expect(names(targets)).toEqual(["Roxie", "Rocky"]);
  });

  describe("precedence", () => {
    it("prefers the names typed over everything else", () => {
      const { rocky, rocco } = seed();
      useRocStore.setState({ focusedRailTerminalId: rocco.id });

      const { targets } = resolveTargets(parseRocCommand("@Roxie go"), {
        selectedIds: [rocky.id],
        activeWorkspaceOnly: false,
      });

      expect(names(targets)).toEqual(["Roxie"]);
    });

    it("falls back to the rail's selection", () => {
      const { rocky, rocco } = seed();
      useUIStore.setState({ focusedTerminalId: rocco.id });

      const { targets } = resolveTargets(parseRocCommand("go"), {
        selectedIds: [rocky.id],
        activeWorkspaceOnly: false,
      });

      expect(names(targets)).toEqual(["Rocky"]);
    });

    // The rail's focus before the dock's: inside Roc, the pane the user pointed
    // this view at is the one they mean.
    it("falls back to whoever is focused, the rail first", () => {
      const { rocky, rocco } = seed();
      useUIStore.setState({ focusedTerminalId: rocky.id });
      useRocStore.setState({ focusedRailTerminalId: rocco.id });

      expect(names(resolveTargets(parseRocCommand("go"), opts).targets)) //
        .toEqual(["Rocco"]);

      useRocStore.setState({ focusedRailTerminalId: null });
      expect(names(resolveTargets(parseRocCommand("go"), opts).targets)) //
        .toEqual(["Rocky"]);
    });

    it("has nothing to say when nothing is selected and nothing is focused", () => {
      seed();
      expect(resolveTargets(parseRocCommand("go"), opts)).toEqual({
        targets: [],
        unknown: [],
      });
    });
  });

  it("drops a selected id whose session has gone", () => {
    const { rocky } = seed();
    const { targets } = resolveTargets(parseRocCommand("go"), {
      selectedIds: [rocky.id, "term_deleted"],
      activeWorkspaceOnly: false,
    });

    expect(names(targets)).toEqual(["Rocky"]);
  });

  // Two panes in two workspaces can both be called Rocky — the pool hands names
  // out per app. Naming one addresses both, which is the honest reading of the
  // token, and each is a distinct target.
  it("addresses every pane that answers to the name", () => {
    const front = newWorkspace({ projectPath: "/front", order: 0 });
    const back = newWorkspace({ projectPath: "/back", order: 1 });
    const a = newTerminal({
      workspaceId: front.id,
      name: "Rocky",
      agentType: "shell",
      projectPath: "/tmp",
    });
    const b = newTerminal({
      workspaceId: back.id,
      name: "Rocky",
      agentType: "shell",
      projectPath: "/tmp",
    });
    useTerminalsStore.getState().setTerminals([a, b]);
    useWorkspacesStore.setState({
      workspaces: [
        { ...front, paneTree: { kind: "leaf", terminalId: a.id } },
        { ...back, paneTree: { kind: "leaf", terminalId: b.id } },
      ],
      activeWorkspaceId: front.id,
    });

    const { targets } = resolveTargets(parseRocCommand("@Rocky go"), {
      selectedIds: [],
      activeWorkspaceOnly: false,
    });

    expect(targets.map((t) => t.terminalId)).toEqual([a.id, b.id]);
  });
});
