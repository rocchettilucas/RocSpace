/** The card editor — one dialog for creating and for editing, because the two
 *  ask the same four questions.
 *
 *  The draft is local until Save, which is what makes Cancel mean something: a
 *  card is a shared document (an agent may be moving it through the MCP server
 *  while this dialog is open) and writing every keystroke through would put
 *  half-typed titles in the repository.
 *
 *  Focus, the scrim and the trap come from `ModalShell`, and so does Escape —
 *  except from inside a text field, where the shell stands down and this
 *  dialog answers for itself. See `handleKeyDown`. */

import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { isTextEntry } from "@/lib/dom";
import { cn } from "@/lib/utils";
import {
  confirmAction,
  ROC_TASK_PRIORITIES,
  useActiveWorkspaceTerminals,
  useBoardTasks,
  useRocPlanStore,
  useTaskEditor,
  useUIStore,
} from "@/stores";
import { ModalShell } from "@/views/Workspaces/ModalShell";
import { PRIORITY_META } from "@/views/RocPlan/taskMeta";
import type { RocTask, RocTaskPriority } from "@/lib/bindings";

/** The `<select>` value carried by the "Unassigned" option.
 *
 *  Not `""` — an empty option value and an agent whose name failed to load
 *  would be indistinguishable — and deliberately an ordinary, greppable string:
 *  it used to be a control character, which made this file BINARY to git and to
 *  every grep the repository audits itself with, and which a webview that
 *  normalised it would have written into the plan file as an agent's name.
 *
 *  Nothing is compared against it either: which option means "nobody" is
 *  answered by its POSITION (it is the first), so the string is only ever the
 *  value the DOM needs an option to carry. */
const UNASSIGNED = "__unassigned__";

export function TaskModal() {
  const target = useTaskEditor();
  if (!target) return null;
  // Keyed so switching cards without closing the dialog starts a fresh draft
  // rather than editing card B with card A's half-typed title.
  return (
    <TaskDialog
      key={`${target.projectPath}:${target.taskId ?? "new"}`}
      projectPath={target.projectPath}
      taskId={target.taskId}
    />
  );
}

/** Exported for tests; app code renders `TaskModal`. */
export function TaskDialog({
  projectPath,
  taskId,
}: {
  projectPath: string;
  taskId: string | null;
}) {
  const close = useUIStore((s) => s.closeTaskEditor);
  const createTask = useRocPlanStore((s) => s.createTask);
  const updateTask = useRocPlanStore((s) => s.updateTask);
  const deleteTask = useRocPlanStore((s) => s.deleteTask);

  const tasks = useBoardTasks(projectPath);
  const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;

  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<RocTaskPriority>(
    task?.priority ?? "medium",
  );
  /** The pane this card answers to, or `null` for nobody — the shape the task
   *  itself stores, so the save below has nothing to translate. */
  const [assignee, setAssignee] = useState<string | null>(
    task?.assignedTerminalName ?? null,
  );

  const names = useAssignableNames(task);
  const canSave = title.trim() !== "";

  // The card was deleted under us — by the agent working it, or by another
  // window. Say so rather than silently saving the draft back as a new task.
  const vanished = taskId !== null && task === null;

  /** The store refused the change. Rare and not the user's fault — the board is
   *  not loaded, so a whole-file write would replace a plan this app has never
   *  read — but the one outcome that must never be reported as a save. */
  const [refused, setRefused] = useState(false);

  const handleSave = () => {
    if (!canSave || vanished) return;
    const patch = {
      title: title.trim(),
      description,
      priority,
      assignedTerminalName: assignee,
    };
    // The dialog closes on the store's word, not on having asked. `createTask`
    // hands back `""` when it refused, and the version that ignored it told the
    // user their task was saved and then dropped it.
    const landed = taskId
      ? updateTask(projectPath, taskId, patch)
      : createTask(projectPath, patch) !== "";
    if (!landed) {
      setRefused(true);
      return;
    }
    close();
  };

  /** Has the user changed anything the dialog would be throwing away? */
  const edited =
    title !== (task?.title ?? "") ||
    description !== (task?.description ?? "") ||
    priority !== (task?.priority ?? "medium") ||
    assignee !== (task?.assignedTerminalName ?? null);

  /** Escape, from inside a text field — the state this dialog OPENS in.
   *
   *  `ModalShell` refuses Escape while a text field has the keyboard, and it is
   *  right to: this dialog asks four questions, and tearing it down to answer
   *  "abandon this word" would throw away the other three. But the shell's
   *  refusal is the whole story only for a dialog you have tabbed into, and
   *  this one starts with the title focused — so Escape was a key that did
   *  nothing until the user found their way out of the field.
   *
   *  So: the first Escape leaves the field, the second (now the shell's) closes
   *  — unless there is nothing to abandon, in which case making the user press
   *  it twice is just a dialog ignoring the first one.
   *
   *  The same shape as the Save session prompt's, which handles its own Escape
   *  on its own input for the same reason: there, the dialog IS the field, so
   *  the two meanings coincide and the first Escape closes. */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!isTextEntry(e.target as Element)) return;
    e.preventDefault();
    // This keystroke is answered here and nowhere else. Without it the shell's
    // document listener sees the SAME event after the focus move below, finds
    // no text field holding the keyboard any more, and closes — which is the
    // second Escape's job, not the first one's.
    e.stopPropagation();
    if (!edited) {
      close();
      return;
    }
    // Not `blur()`: focus on the body is focus outside the dialog, which is
    // what the shell's trap exists to prevent. This lands on the dialog's own
    // body, which is focusable and is not a text field.
    bodyRef.current?.focus();
  };

  const handleDelete = async () => {
    if (!taskId || vanished) return;
    const ok = await confirmAction({
      title: "Delete card",
      message: `Delete “${task?.title ?? "this task"}”?`,
      detail:
        "The card leaves .rocspace/plan.json, findings and all. Nothing an agent already did is undone.",
      confirmLabel: "Delete card",
      tone: "danger",
    });
    if (!ok) return;
    if (!deleteTask(projectPath, taskId)) {
      setRefused(true);
      return;
    }
    close();
  };

  return (
    <ModalShell
      title={taskId ? "Edit task" : "New task"}
      onClose={close}
      initialFocusRef={titleRef}
      footer={
        <>
          {taskId ? (
            <button
              type="button"
              // Dead for the same reason Save is: there is no card left to
              // delete. Live, it asked `Delete "this task"?` — the fallback
              // title, because the card it would have named is gone — and then
              // reported the refusal as "RocSpace is not holding this project's
              // plan", which is the wrong reason for the right refusal. The
              // banner above already says the true one.
              disabled={vanished}
              onClick={() => void handleDelete()}
              className={cn(
                "mr-auto flex items-center gap-1.5 rounded-input px-2.5 py-1.5 text-xs",
                vanished
                  ? "cursor-not-allowed text-fg-muted"
                  : "text-fg-secondary hover:bg-error/15 hover:text-error",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          ) : null}
          <button
            type="button"
            onClick={close}
            className="rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave || vanished}
            onClick={handleSave}
            className={cn(
              "rounded-input px-3.5 py-1.5 text-xs font-medium",
              canSave && !vanished
                ? "bg-accent text-accent-fg hover:opacity-90"
                : "cursor-not-allowed bg-surface-2 text-fg-muted",
            )}
          >
            {taskId ? "Save task" : "Create task"}
          </button>
        </>
      }
    >
      {/* The dialog's own body, and a focus target that is not a text field.
          The shell's Escape stands down while one has the keyboard — Escape
          there means "abandon what I typed", and answering it by tearing the
          whole dialog down throws away the three other answers the user gave —
          so in a dialog that opens WITH the title field focused, Escape did
          nothing at all until the user tabbed away. `onKeyDown` below is the
          missing half, and this node is where the first Escape puts focus. */}
      <div
        ref={bodyRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="flex flex-col gap-5 outline-none"
      >
        {vanished ? (
          <p className="rounded-input bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
            This card is no longer on the board — something else deleted it
            while you had it open. Close the dialog; nothing here will be saved.
          </p>
        ) : null}

        {refused ? (
          <p className="rounded-input bg-error/10 px-2.5 py-2 text-[11px] leading-relaxed text-error">
            Nothing was saved — RocSpace is not holding this project&apos;s
            plan, so writing would replace a file it has never read. Nothing
            here is lost; reopen the board and try again.
          </p>
        ) : null}

        <Field label="Title" htmlFor="task-title">
          <input
            id="task-title"
            ref={titleRef}
            value={title}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-input border border-border bg-surface-0 px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:border-border-active"
          />
        </Field>

        <Field label="Description" htmlFor="task-description">
          <textarea
            id="task-description"
            value={description}
            rows={5}
            spellCheck={false}
            onChange={(e) => setDescription(e.target.value)}
            className="resize-y rounded-input border border-border bg-surface-0 px-2.5 py-1.5 text-xs leading-relaxed text-fg-primary outline-none focus:border-border-active"
          />
          <p className="text-[10px] leading-relaxed text-fg-muted">
            Goes to the agent verbatim when the card reaches In Progress, so
            write it as the prompt you would have typed.
          </p>
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Priority
          </legend>
          {/* Native radios: the arrow-key behaviour inside a group is the
            browser's, which is one fewer keydown handler to get right and one
            fewer row the Shortcuts table has to claim. */}
          <div className="flex flex-wrap gap-1">
            {ROC_TASK_PRIORITIES.map((value) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                  priority === value
                    ? "border-transparent text-fg-primary"
                    : "border-border text-fg-secondary hover:bg-surface-2",
                )}
                style={
                  priority === value
                    ? {
                        background: `color-mix(in srgb, ${PRIORITY_META[value].tint} 16%, transparent)`,
                      }
                    : undefined
                }
              >
                <input
                  type="radio"
                  name="task-priority"
                  value={value}
                  checked={priority === value}
                  onChange={() => setPriority(value)}
                  className="h-3 w-3 accent-accent"
                />
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: PRIORITY_META[value].tint }}
                />
                {PRIORITY_META[value].label}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Assigned agent" htmlFor="task-assignee">
          <select
            id="task-assignee"
            value={assignee ?? UNASSIGNED}
            // By position, not by string: the first option is "nobody", every
            // other one is a pane and carries its own name.
            onChange={(e) =>
              setAssignee(e.target.selectedIndex === 0 ? null : e.target.value)
            }
            className="rounded-input border border-border bg-surface-0 px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:border-border-active"
          >
            <option value={UNASSIGNED}>Unassigned</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="text-[10px] leading-relaxed text-fg-muted">
            Panes in this workspace, by name. Leave it unassigned and the card
            takes whichever pane is focused when it reaches In Progress.
          </p>
        </Field>

        {task && task.findings.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Findings {task.findings.length}
            </span>
            {/* Read-only, and append-only underneath: findings are a record of
              what happened, and an editable history is not one. */}
            <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
              {task.findings.map((finding, i) => (
                <li
                  key={`${finding.at}-${i}`}
                  className="rounded-input bg-surface-2/60 px-2.5 py-1.5"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] font-medium text-fg-secondary">
                      {finding.by}
                    </span>
                    <span className="text-[10px] tabular-nums text-fg-muted">
                      {new Date(finding.at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-fg-primary">
                    {finding.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

/** Pane names this card can be assigned to.
 *
 *  The workspace's panes, plus whatever the card already names even when no
 *  pane answers to it any more — a session closed since the card was assigned
 *  must not be silently dropped by the act of opening the card to read it. */
function useAssignableNames(task: RocTask | null): string[] {
  const sessions = useActiveWorkspaceTerminals();
  const names = sessions.map((s) => s.name);
  const assigned = task?.assignedTerminalName;
  if (assigned && !names.includes(assigned)) names.push(assigned);
  return names;
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={htmlFor}
        className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
