import type { AgentType } from "@/lib/bindings";

export const AGENT_BADGE: Record<AgentType, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  "open-code": "OpenCode",
  shell: "Shell",
  custom: "Custom",
};

/** Full product names — for prose and pickers, where "Claude" is too terse to
 *  tell you which CLI you are choosing. `AGENT_BADGE` stays the short form for
 *  pane chrome, where horizontal space is the constraint. */
export const AGENT_NAME: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "open-code": "OpenCode",
  shell: "Shell",
  custom: "Custom",
};

/** Names a new pane can be born with.
 *
 *  Panes used to be named after the CLI running in them ("Claude 2",
 *  "Shell 1"), which said the same thing the agent badge already says and left
 *  the user with nothing to call a pane by. A roc name is a handle: it survives
 *  a change of agent, it is what the user says out loud ("what is Roxie doing"),
 *  and it is what a future multi-target Roc dispatch will address.
 *
 *  Order is the order they are handed out, so the first few panes of a fresh
 *  workspace are the most recognisable ones. */
export const ROC_NAMES: readonly string[] = [
  "Rocky",
  "Roxie",
  "Rocco",
  "Rocket",
  "Rockwell",
  "Roxanne",
  "Sprocket",
  "Brock",
  "Rockford",
  "Rochelle",
  "Rocio",
  "Rockette",
  "Rockne",
  "Roxby",
  "Rocca",
  "Rockley",
];

/** The first roc name `taken` does not already hold: the pool in order, then
 *  `"{name} 2"`, `"{name} 3"`, … once it is exhausted.
 *
 *  Takes the taken set rather than a count on purpose. Numbering off how many
 *  panes exist mints duplicates the moment one is closed out of order — with
 *  Rocky/Roxie/Rocco open, closing Roxie leaves a count of two, so the next
 *  pane was a second Rocco. A name is how the user addresses a pane, so two
 *  panes answering to one is a real ambiguity. Asking what is taken also steps
 *  over anything the user renamed by hand, for free.
 *
 *  Terminates: each pass offers `ROC_NAMES.length` names none of the earlier
 *  passes produced, so pass `taken.size + 1` cannot be fully taken. */
export function nextRocName(taken: ReadonlySet<string>): string {
  for (let pass = 1; ; pass++) {
    for (const name of ROC_NAMES) {
      const candidate = pass === 1 ? name : `${name} ${pass}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

/** `base` when nothing holds it, otherwise the lowest free `"{base} N"`.
 *
 *  The disambiguating half of `nextRocName`, for a name that came from the user
 *  rather than from the pool: a rename typed onto a name a sibling pane already
 *  answers to keeps the word the user chose and takes the next number, the same
 *  shape an exhausted pool falls back to ("Rocky 2"). Numbering from 2 because
 *  the un-suffixed name is the one already in use — it is the first.
 *
 *  Terminates: `taken` is finite, so some N is free. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every `AgentType`, as a runtime list — for `<select>` options and for
 *  validating values read back off disk.
 *
 *  Derived from `AGENT_BADGE` rather than written out again on purpose: that
 *  record is typed `Record<AgentType, …>`, so adding a member to the union
 *  fails to compile until it is listed there, which keeps this exhaustive. */
export const AGENT_TYPES = Object.keys(AGENT_BADGE) as AgentType[];

/** The types a picker may OFFER, which is not the same list.
 *
 *  `custom` is withdrawn: `custom_spec` reads `custom_args` and nothing in the
 *  app can write it — `factories.ts` hard-codes it to null and no editor
 *  exists — so `launch_spec` returns `None` and the pane opens a plain
 *  interactive shell. Choosing "Custom" bought a Shell wearing a different
 *  badge, which is a lie the pane's own header repeated.
 *
 *  Withdrawn from the CHOICE only. It stays in `AGENT_TYPES`, so a persisted
 *  default and a saved session that carry it still validate, load, spawn and
 *  display; `agentChoices` puts it back in the one list where it is already
 *  the answer. Put it back here when there is an editor for the argv. */
export const SELECTABLE_AGENT_TYPES: readonly AgentType[] = AGENT_TYPES.filter(
  (type) => type !== "custom",
);

/** What a picker should list: the selectable types, plus anything already
 *  chosen. A control that silently dropped its own value would read as a
 *  different setting than the one in force. */
export function agentChoices(...chosen: AgentType[]): AgentType[] {
  return AGENT_TYPES.filter(
    (type) => SELECTABLE_AGENT_TYPES.includes(type) || chosen.includes(type),
  );
}

/** Does RocSpace pass this agent's permission settings down to its CLI?
 *
 *  Exactly one builder in `src-tauri/src/agents/command.rs` calls
 *  `permission_args`: `claude_code_spec`. `codex_spec`, `opencode_spec`,
 *  `custom_spec` and the plain shell build their argv without a permission
 *  flag in it, so every toggle and every mode is inert on those panes — they
 *  run with whatever their own CLI allows.
 *
 *  A predicate rather than a comparison at each call site because the UI has
 *  to be able to say so in three places (the Inspector's switches, Settings'
 *  modes, and the warning under them), and a safety control that disagrees
 *  with itself across two of them is worse than one that is simply wrong. */
export function supportsPermissions(type: AgentType): boolean {
  return type === "claude-code";
}
