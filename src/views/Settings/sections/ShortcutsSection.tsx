import { acceleratorChips, isDomOnlyAccelerator } from "@/lib/accelerator";
import { isMacOS, isWindows } from "@/lib/platform";
import { useVoiceSettings, WINDOWS_PTT_ACCELERATOR } from "@/stores";
import { SettingsNote, SettingsSection } from "@/views/Settings/rows";

/** Only bindings that actually exist today — and *all* of them.
 *
 *  Listing aspirational chords here would just teach people keys that do
 *  nothing. Every row below maps to a real handler; grep the key name (`Arrow`
 *  for the arrow row) to find it.
 *
 *  The section header calls this "the whole list", which makes an omission a
 *  lie rather than an oversight: when you add a keydown handler anywhere in the
 *  app, add its row here. `grep -rn "keydown\|onKeyDown\|onKeyUp" src/` is the
 *  audit — today it is RocDock's pane chords, the workspace chords, the zoom
 *  chords, ⌘K's palette and its own arrows/Enter/Escape, the editor's ⌘S and
 *  ⌘P, the Go to file box's own arrows/Enter/Escape, RocTalk's push-to-talk
 *  hold, Roc's ⌘⇧R, its command bar's Enter and ⌘Enter and its rail's
 *  arrows/Space, the live terminal's own Enter, RocMind's ⌘⇧M — which is all
 *  RocMind binds; it has no command bar and no rail — the Git panel's ⌘⇧K, its
 *  commit box's ⌘Enter and its branch dialog's Enter/Escape, the confirmation
 *  dialog's own Enter, the Escape handlers in SettingsView / NotificationBell /
 *  `ModalShell` and its focus trap, the Save session prompt's own Enter/Escape,
 *  the card editor's own Escape, the sidebar's workspace rename, its tablist
 *  arrows and its rows' Enter/Space, the accent picker's Escape,
 *  AppearanceSection's arrow keys, the Roc widget's mode radiogroup, the
 *  push-to-talk picker's capture listener — which takes EVERY key while it is
 *  armed — NotificationBell's Enter, the RocPlan card's arrows and Enter, and
 *  the browser address bar's Enter.
 *
 *  An ALIAS is not a row of its own — ⌘= and ⌘_ are the same physical keys as
 *  ⌘+ and ⌘−, and printing them twice would make the table look like there are
 *  five zoom chords. They are named in the scope of the row they belong to,
 *  which is where somebody looking for "why did that work" will read.
 *
 *  # Where a chord is bound decides where it works
 *
 *  Two homes, and the difference is visible to the user. `App` binds ⌘T, ⌘1-9,
 *  ⌘⇧S, ⌘⇧P, ⌘K and the zoom keys above the workspace gate, so they answer
 *  with nothing open. Everything else is bound by a hook inside `AppShell` or
 *  `RocDock`, which `App.tsx` does not render while there are zero workspaces
 *  — so those chords do not merely find nothing to act on, they are not bound
 *  at all. Their scope says so rather than claiming "anywhere". */

/** Where the four pane chords are live.
 *
 *  One string because they share one guard — and the guard is not only about
 *  modals: RocPlan takes the dock's place while the dock stays mounted behind
 *  it, so "the dock is what the main area is showing" is part of the answer.
 *  The workspace clause is the third part: `RocDock` binds these, and there is
 *  no dock before there is a workspace. */
const PANE_SCOPE =
  "The terminals view, with at least one workspace open, except in a text field and under Settings or any open modal — not while RocPlan or Roc has the main area";

interface Shortcut {
  keys: string[];
  action: string;
  scope: string;
}

/** The table's rows. A function rather than a constant because one binding is
 *  not fixed any more: push-to-talk is whatever the user chose (or, on Windows,
 *  the key the keyboard hook owns), and a table that promises "the whole list"
 *  cannot print a key that is no longer bound. Its SCOPE moves with the choice
 *  too — a bare key is only heard while RocSpace is in front. */
function shortcuts(pttKeys: string[], pttScope: string): readonly Shortcut[] {
  return [
    {
      keys: ["⌘", "K"],
      action: "Open the command palette — every action in the app, by name",
      scope:
        "Anywhere except a text field and any open modal. Pressing it again inside the palette closes it, from the search box included",
    },
    {
      keys: ["↑", "↓"],
      action: "Move to the next command",
      scope: "The command palette — the list wraps at both ends",
    },
    {
      keys: ["Enter"],
      action: "Run the highlighted command",
      scope: "The command palette",
    },
    {
      keys: ["Esc"],
      action: "Close the command palette without running anything",
      scope: "The command palette, including from inside its search box",
    },
    {
      keys: ["⌘", "+"],
      action: "Make everything bigger — the chrome, not the terminals",
      scope:
        "Anywhere, Settings and open dialogs included: it scales the window, which is the one thing you can always see. ⌘= is the same key unshifted",
    },
    {
      keys: ["⌘", "−"],
      action: "Make everything smaller",
      scope:
        "Anywhere, on the same terms as ⌘+. ⌘_ is the same key shifted, and means the same thing",
    },
    {
      keys: ["⌘", "0"],
      action: "Back to 100%",
      scope:
        "Anywhere. Zero is free because the workspace switcher only claims ⌘1 – ⌘9",
    },
    {
      keys: ["⌘", "T"],
      action: "New workspace",
      scope: "Anywhere except Settings, a text field, and any open modal",
    },
    {
      keys: ["⌘", "1"],
      action: "Switch to the nth workspace, counting down the sidebar",
      scope:
        "⌘1 – ⌘9, anywhere except Settings, a text field, and any open modal",
    },
    {
      keys: ["⌘", "⇧", "S"],
      action: "Save the active workspace as a named session",
      scope:
        "Anywhere except Settings, a text field, and any open modal — the Save session prompt included, once it is up",
    },
    {
      keys: ["⌘", "⇧", "P"],
      action: "Show the RocPlan board, or go back to the terminals",
      scope:
        "Anywhere except Settings, a text field, and any open modal — with at least one workspace open",
    },
    {
      keys: ["⌘", "⇧", "M"],
      action: "Show RocMind, or go back to the terminals",
      scope:
        "Anywhere with at least one workspace open, except Settings and any open modal — and from inside RocMind's search box too, or the way out would be unreachable from the box you are typing in. ⌘M is left alone: it minimises the window",
    },
    {
      keys: ["⌘", "⇧", "R"],
      action: "Show Roc, or go back to the terminals",
      scope:
        "Anywhere with at least one workspace open, except Settings and any open modal — and from inside Roc's own text fields too, or the way out would be unreachable from the box you are typing in. ⌘R is left alone: it reloads",
    },
    {
      keys: ["⌘", "⇧", "K"],
      action: "Open the Git panel with the commit message box focused",
      scope:
        "Anywhere with at least one workspace open, except Settings, a text field, and any open modal — it expands the right panel and switches it to Git, so it works from the board and from Roc too",
    },
    {
      keys: ["⌘", "P"],
      action: "Open a file by name (fuzzy)",
      scope:
        "Anywhere with at least one workspace open, except Settings, any open modal, and a text field — but from inside the code editor itself. Needs a project directory too; ⌘⇧P is the board, and stays the board",
    },
    {
      keys: ["↑", "↓"],
      action: "Move down the list of matching files",
      scope: "The Go to file box",
    },
    {
      keys: ["Enter"],
      action: "Open the highlighted file in the editor",
      scope:
        "The Go to file box — the panel comes forward with it, because a file opened behind a collapsed one reads as nothing having happened",
    },
    {
      keys: ["⌘", "S"],
      action: "Save the file the editor is on",
      scope:
        "Anywhere with at least one workspace open, except Settings, any open modal, and a text field — but from inside the code editor itself, which is a text field and is the one place this has to work. Does nothing when there is nothing unsaved. Save all is in the command palette, because ⌘⇧S is already the session save",
    },
    {
      keys: ["⌘", "D"],
      action: "Split the focused pane to the right",
      scope: PANE_SCOPE,
    },
    {
      keys: ["⌘", "⇧", "D"],
      action: "Split the focused pane downwards",
      scope: PANE_SCOPE,
    },
    {
      keys: ["⌘", "N"],
      action: "New pane beside the focused one",
      scope: PANE_SCOPE,
    },
    {
      keys: ["⌘", "W"],
      action: "Close the focused pane (confirms while it is running)",
      scope: PANE_SCOPE,
    },
    {
      keys: pttKeys,
      action:
        "Hold to dictate (RocTalk) — into the focused terminal or Roc's command bar, whichever Voice is set to",
      scope: pttScope,
    },
    {
      keys: ["Enter"],
      action: "Send the message to every agent it is aimed at",
      scope: "Roc's command bar",
    },
    {
      keys: ["⌘", "Enter"],
      action: "Start a new line instead of sending",
      scope: "Roc's command bar — ⇧Enter does the same",
    },
    {
      keys: ["↑", "↓"],
      action: "Move to the next session and watch it",
      scope: "Roc's sessions rail, with a row focused",
    },
    {
      keys: ["Space"],
      action: "Tick or untick the session Roc is on as a target",
      scope:
        "Roc's sessions rail, with a row focused — the checkbox itself already takes Space",
    },
    {
      keys: ["Enter"],
      action: "Send what is typed to the session on screen",
      scope: "Roc's live terminal box — one pane, typed at, not a dispatch",
    },
    {
      keys: ["Esc"],
      action: "Close Settings",
      scope: "While Settings is open",
    },
    {
      keys: ["Esc"],
      action: "Close the open popover",
      scope:
        "Notifications, and the sidebar's accent picker — from inside it or from the row",
    },
    {
      keys: ["Esc"],
      action: "Close the New Workspace modal, keeping nothing",
      scope: "While it is open, unless a text field has the keyboard",
    },
    {
      keys: ["Tab"],
      action: "Move to the next control — focus cannot leave the dialog",
      scope: "The New Workspace modal, ⇧Tab for the other direction",
    },
    {
      keys: ["Enter"],
      action: "Save the session under the typed name",
      scope: "The Save session as… prompt",
    },
    {
      keys: ["Esc"],
      action: "Close the Save session as… prompt",
      scope: "While it is open, including from inside the name field",
    },
    {
      keys: ["Enter"],
      action: "Answer yes to a confirmation",
      scope:
        "Any “are you sure?” dialog, from anywhere inside it — focus opens on Cancel, so a Return there means the question and not the button under it. A Return you were already HOLDING when the dialog appeared does not count",
    },
    {
      keys: ["Esc"],
      action: "Answer no to a confirmation",
      scope: "Any “are you sure?” dialog — the same answer as Cancel",
    },
    {
      keys: ["Esc"],
      action: "Dismiss the editor's question about a file, changing nothing",
      scope:
        "The unsaved-changes and changed-on-disk dialogs — the tab stays open and the buffer stays as it is",
    },
    {
      keys: ["Esc"],
      action: "Close the Go to file box",
      scope: "While it is open, including from inside the search field",
    },
    {
      keys: ["Esc"],
      action: "Close the card editor, keeping nothing",
      scope:
        "The RocPlan card editor — from Title or Description, the first Esc leaves the field and the second closes, unless nothing has been typed yet",
    },
    {
      keys: ["⌘", "Enter"],
      action: "Commit what is staged",
      scope:
        "The Git panel's commit message box — Enter alone is a newline, because a commit message has a subject line and a body",
    },
    {
      keys: ["Enter"],
      action:
        "Check out the first branch listed, or create the one whose name is typed",
      scope: "The Git panel's Switch branch dialog, from the filter field",
    },
    {
      keys: ["Esc"],
      action: "Close the Switch branch dialog",
      scope: "While it is open, including from inside the filter field",
    },
    {
      keys: ["Esc"],
      action: "Close the New worktree or Ask an agent dialog, keeping nothing",
      scope:
        "While one is open, unless a text field has the keyboard — Tab cannot leave either dialog",
    },
    {
      keys: ["Enter"],
      action: "Commit a rename",
      scope: "While renaming a workspace or a pane",
    },
    {
      keys: ["Esc"],
      action: "Cancel a rename",
      scope: "While renaming a workspace or a pane",
    },
    {
      keys: ["↑", "↓"],
      action: "Move to the next workspace and switch to it",
      scope: "The sidebar's workspace list, with a row focused",
    },
    {
      keys: ["Enter", "Space"],
      action: "Switch to the focused workspace",
      scope: "The sidebar's workspace list, with a row focused",
    },
    {
      keys: ["←", "→"],
      action: "Move the focused card to the previous / next column",
      scope:
        "The RocPlan board — only across the columns on screen, so a card cannot walk into Cancelled while it is hidden",
    },
    {
      keys: ["Enter", "Space"],
      action: "Open the focused card",
      scope: "The RocPlan board",
    },
    {
      keys: ["↑", "↓", "←", "→"],
      action: "Move to the next option and apply it",
      scope:
        "Settings, inside a group of choices — the Appearance theme cards, the Agents permission modes",
    },
    {
      keys: ["Enter"],
      action: "Open the notification's terminal",
      scope: "Notifications, with a notification focused",
    },
    {
      keys: ["Enter"],
      action: "Navigate to the typed address",
      scope: "Browser address bar",
    },
    {
      keys: ["↑", "↓", "←", "→"],
      action: "Switch what the push-to-talk key does, and apply it",
      scope:
        "The Roc widget's mode switch, with it focused — Home and End go to the ends. The same control as Settings › Voice › Send transcripts to",
    },
    {
      // One chip, not two: "Any" and "key" as separate keys would read as a
      // chord nobody can press.
      keys: ["Any key"],
      action:
        "Bind it as push-to-talk. Nothing else in the app hears the key while the picker is armed",
      scope:
        "Settings › Voice, after clicking the push-to-talk key — Esc backs out and binds nothing",
    },
  ];
}

export function ShortcutsSection() {
  const voice = useVoiceSettings();
  // The picker is inert on Windows — the keyboard hook owns Caps Lock there —
  // so the table shows what is actually bound rather than what is stored.
  const pttKeys = isWindows()
    ? acceleratorChips(WINDOWS_PTT_ACCELERATOR)
    : acceleratorChips(voice.accelerator, { mac: isMacOS() });
  // The Windows hook hears its key from anywhere; a chord the OS registered
  // does too. A bare key outside Windows is neither — nothing global carries
  // it, so it reaches RocSpace and stops there.
  const pttScope =
    !isWindows() && isDomOnlyAccelerator(voice.accelerator)
      ? "While RocSpace is in front, RocTalk is on and the model is ready. Settings → Voice rebinds it"
      : "Anywhere, while RocTalk is on and the model is ready. Settings → Voice rebinds it";

  return (
    <SettingsSection
      title="Shortcuts"
      description="Everything RocSpace binds today. This is the whole list — not a selection."
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            <th className="w-28 py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Key
            </th>
            <th className="py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Action
            </th>
            <th className="py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Where
            </th>
          </tr>
        </thead>
        <tbody>
          {shortcuts(pttKeys, pttScope).map(({ keys, action, scope }, i) => (
            <tr key={i} className="border-b border-border last:border-b-0">
              <td className="py-2 align-top">
                <span className="flex flex-wrap gap-1">
                  {keys.map((key, k) => (
                    <kbd
                      key={k}
                      className="rounded-input border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary"
                    >
                      {key}
                    </kbd>
                  ))}
                </span>
              </td>
              <td className="py-2 align-top text-xs text-fg-primary">
                {action}
              </td>
              <td className="py-2 align-top text-[11px] leading-relaxed text-fg-muted">
                {scope}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <SettingsNote>
        &quot;Any open modal&quot; is one rule, not a list: while Settings or a
        dialog is up it owns the keyboard, and every ⌘ chord above stands down
        until it closes. A scrim stops the mouse but not the keys, so a chord
        that kept firing would act on a pane you cannot see — ⌘W closing one
        behind the dialog is the shape that takes. RocPlan and Roc are the same
        rule without a scrim: each takes the terminals&apos; place while they
        keep running behind it, so the four pane chords wait there too. The zoom
        keys are the one exception, and for the reason the rule exists: they act
        on the window, which is never the thing you cannot see.
      </SettingsNote>

      <SettingsNote tone="warning">
        None of these reach the Browser panel. The web preview is a native child
        webview with its own window, not a frame inside this one, so a key
        pressed while it has focus never arrives here — click a pane, the
        sidebar or anything else in RocSpace first, and the chords come back.
        The menu bar&apos;s own shortcuts are the exception: those are handled
        by macOS, above every window.
      </SettingsNote>

      <SettingsNote>
        Pane chords are ⌘-only: Ctrl-D is end-of-input in every shell these
        panes run, so binding it to a split would be a destructive misfire.
        Rebinding, and a Windows map, are planned — Settings will list them here
        as they land.
      </SettingsNote>
    </SettingsSection>
  );
}
