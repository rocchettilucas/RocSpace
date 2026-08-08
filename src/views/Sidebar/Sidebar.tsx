import { RocMindRow } from "@/views/Sidebar/RocMindRow";
import { RocPlanRow } from "@/views/Sidebar/RocPlanRow";
import { SavedSessions } from "@/views/Sidebar/SavedSessions";
import { WorkspaceList } from "@/views/Sidebar/WorkspaceList";

/** The left rail: the workspaces that are open, the board over them, and the
 *  sessions that are saved.
 *
 *  Profiles and groups are gone — a workspace is the project, the layout and
 *  the colour all at once, so the two nested lists that used to live here
 *  collapse into the tablist. The footer is the one place the two halves meet:
 *  what is running above, what is on disk below.
 *
 *  RocPlan sits between them because it is neither: it is a view of whichever
 *  workspace is active, not one of them and not something saved. RocMind sits
 *  beside it and is not even that — it is every project's memories at once,
 *  which is why it is a row here and not a workspace: it belongs to no one of
 *  them. */
export function Sidebar() {
  return (
    <aside className="flex h-full flex-col bg-surface-1">
      <WorkspaceList />
      <RocPlanRow />
      <RocMindRow />
      <SavedSessions />
    </aside>
  );
}
