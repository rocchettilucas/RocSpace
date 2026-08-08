import {
  useNotificationSettings,
  useSettingsStore,
  type NotificationSettings,
} from "@/stores";
import {
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/views/Settings/rows";

/** Sound only.
 *
 *  There is deliberately no switch for the green glow or for the bell's list:
 *  they cost nothing to ignore, and someone reaching for these controls is
 *  asking for quiet rather than for blindness. The master mute reads that way
 *  too — it silences every kind, including the ones with no switch of their
 *  own, and leaves every visible signal exactly where it was. */
export function NotificationsSection() {
  const notifications = useNotificationSettings();
  const setNotificationOption = useSettingsStore(
    (s) => s.setNotificationOption,
  );

  // The switch's accessible name is the row's label, so the two cannot drift.
  const toggle = (key: keyof NotificationSettings, label: string) => (
    <SettingsToggle
      label={label}
      checked={notifications[key]}
      onChange={(next) => setNotificationOption(key, next)}
    />
  );

  return (
    <SettingsSection
      title="Notifications"
      description="What the app is allowed to make a noise about. The bell and the green border on a finished pane are not switchable — muting the room should not cost you the things you can only see."
    >
      <SettingsRow
        label="Sound when an agent finishes"
        description="Every pane whose agent ends a turn lights up green and dings once — the one you are watching included, because with four panes working the finished one is often just the pane your cursor happens to be in. A dialog on top of a pane holds its sound back until you dismiss it; the glow and the bell entry land either way."
      >
        {toggle("turnFinishedSound", "Sound when an agent finishes")}
      </SettingsRow>

      <SettingsRow
        label="Sound when an agent needs permission"
        description="An agent that stops to ask before running something. Unchanged from what RocSpace has always done."
      >
        {toggle("approvalSound", "Sound when an agent needs permission")}
      </SettingsRow>

      <SettingsRow
        label="Mute every sound"
        description="Silences the two above and everything else — a pane exiting, a crash, a card sent for review. Nothing you can see changes."
      >
        {toggle("muted", "Mute every sound")}
      </SettingsRow>

      <SettingsNote>
        Only Claude Code panes have a turn to finish: RocSpace learns about it
        from that CLI&apos;s lifecycle hooks. Codex, opencode and plain shells
        report no such boundary, so they keep the behaviour they have always had
        — a pane that has gone quiet is called &ldquo;awaiting&rdquo;, and there
        is nothing to say when a reply ends.
      </SettingsNote>
    </SettingsSection>
  );
}
