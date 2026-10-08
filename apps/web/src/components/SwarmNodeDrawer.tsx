import { Fragment, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Markdown } from "./Markdown.js";
import { CompletionRing } from "./CompletionRing.js";
import { useDismissable } from "./ui.js";
import { attentionNote, diagramAttentionWords, diagramTaskTone, diagramTaskWords, isAttention } from "../swarm/status.js";
import { formatCompletion, type SwarmNode } from "../swarm/layout.js";
import { cappedUsd, formatUsd } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";
import { MERGE_QUEUE_FAILURE } from "../swarm/failures.js";
import type { SwarmNodeDetail, SwarmTask, SwarmTaskEvent } from "../swarm/types.js";

/**
 * One node, opened.
 *
 * The same drawer whichever view was showing when it was opened, and
 * the same selection behind it, so switching between Tree and Outline
 * with a node open keeps the node open.
 *
 * Everything here except the figures was written by an agent, and an
 * agent reads untrusted input all day. Titles, descriptions,
 * criteria and flags render as text. The report renders through the
 * console's markdown path, which has raw HTML off, so an injected
 * payload in a report is a paragraph that reads oddly and never a
 * script running as the console.
 */
export function SwarmNodeDrawer({
  task,
  node,
  detail,
  repositoriesNamed = 1,
  onClose,
  onMarkDone,
  onRetry,
  onRetryLanding,
  onFixForward,
  onOpenRun,
  onCancel,
  onSplit,
  onAddTask,
  onReassign,
  onEdit,
  agents = [],
  transcript,
  busy,
  actionError,
}: {
  task: SwarmTask;
  /** The rolled up figures for this node, from the shared model. */
  node: SwarmNode;
  /**
   * This node's commits and its history, once the board has fetched
   * them.
   *
   * Absent while the request is in flight, and absent for a caller
   * that does not fetch them at all, which is what the fixtures do.
   * The commits then fall back to whatever the plan row carried.
   */
  detail?: SwarmNodeDetail;
  /** How many repositories the project spans, which decides one chip. */
  repositoriesNamed?: number;
  onClose: () => void;
  /**
   * Marks a leaf done by hand.
   *
   * Still optional, because a caller that has no swarm selected has
   * nothing to send it to. A drawer given no handler omits the action.
   */
  onMarkDone?: (taskId: string) => void;
  /**
   * The node controls.
   *
   * Each one optional, because a caller with no swarm selected has
   * nowhere to send it, and a button wired to nothing is worse than no
   * button: the drawer omits actions that have no handler.
   */
  onRetry?: (taskId: string) => void;
  onRetryLanding?: (taskId: string) => void;
  onFixForward?: (taskId: string, reason: string) => void;
  onOpenRun?: (runId: string) => void;
  onCancel?: (taskId: string) => void;
  onSplit?: (taskId: string, children: { title: string }[]) => void;
  /**
   * Adds work below this node. Under a worker leaf, it starts after
   * that leaf finishes. The planner is told and may object.
   */
  onAddTask?: (parentId: string, task: { title: string; description?: string }) => void;
  onReassign?: (taskId: string, agentProfileId: string | null) => void;
  onEdit?: (taskId: string, edit: { description: string }) => void;
  /** The agents this project can put on a leaf, for Reassign. */
  agents?: { id: string; name: string }[];
  /** Read-only output from the worker run assigned to this task. */
  transcript?: ReactNode;
  busy?: boolean;
  actionError?: string;
}) {
  const panel = useDismissable<HTMLElement>(onClose);
  const [confirming, setConfirming] = useState(false);
  const [tab, setTab] = useState("overview");
  const mergeQueueFailure = task.nodeType === "leaf" && typeof task.flags.landingError === "string";
  const attention = isAttention(node.attention);
  const note = task.nodeType === "plan" && task.status === "failed" && !node.agentActive ? null
    : diagramAttentionWords(task.status, task.nodeType, node.attention, node.agentActive);
  const longNote = mergeQueueFailure ? null : task.nodeType === "plan" && task.status === "failed" && !node.agentActive
    ? "A task below this plan failed. Open it to fix or retry it."
    : attentionNote(node.attention);
  const retries = Number((task.flags as { retries?: unknown }).retries ?? 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const [fixingForward, setFixingForward] = useState(false);
  const [fixReason, setFixReason] = useState(typeof task.flags.rejection === "string" ? task.flags.rejection : "");
  const [splitting, setSplitting] = useState(false);
  const [splitText, setSplitText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addDetail, setAddDetail] = useState("");
  const flags = Object.entries(task.flags).filter(([key]) => key !== "landingError");
  // The fetched list when there is one, and the plan row's otherwise.
  // A fetched empty list is an answer, not a missing one, so the
  // fallback is on the detail being absent rather than on it being
  // empty.
  const commits = detail ? detail.commits : task.commits;
  const events = detail?.events ?? [];
  const runs = detail?.runs ?? [];
  const canFixForward = !!onFixForward && task.nodeType === "leaf" && task.status === "failed" && !mergeQueueFailure;
  const canMarkDone = !!onMarkDone && task.nodeType === "leaf" && task.status !== "done";
  const canRetry = !!onRetry && task.nodeType === "leaf" && !mergeQueueFailure && !["cancelled", "done", "landed"].includes(task.status);
  const canRetryLanding = !!onRetryLanding && mergeQueueFailure;
  const canEdit = !!onEdit;
  const canSplit = !!onSplit && task.nodeType === "leaf" && task.status !== "done";
  const canAdd = !!onAddTask && task.status !== "done" && task.status !== "cancelled";
  const canCancel = !!onCancel && task.status !== "cancelled";
  const workerActive = task.nodeType === "leaf" && task.status === "working";
  const primaryAction = canRetryLanding ? "landing"
    : canFixForward ? "fix"
    : (task.status === "failed" || (task.status === "assigned" && task.assignedRunId)) && canRetry ? "retry"
    : workerActive ? null : canAdd && task.nodeType === "plan" ? "add" : canEdit ? "edit" : canRetry ? "retry" : null;
  const hasMoreActions = canMarkDone || (canRetry && primaryAction !== "retry") ||
    (canEdit && primaryAction !== "edit") || canSplit || (canAdd && primaryAction !== "add") ||
    canCancel || (!!onReassign && task.nodeType === "leaf" && agents.length > 0);
  const nextStep = mergeQueueFailure ? MERGE_QUEUE_FAILURE
    : primaryAction === "fix" ? "Tell the worker what to change."
    : primaryAction === "retry" ? (task.status === "assigned" ? "Start a new worker attempt." : null)
    : workerActive ? (node.agentActive ? "The worker is running. Open Worker logs to follow its progress." : "Waiting for an agent to start.")
      : primaryAction === "add" ? "Add a task to this plan."
        : primaryAction === "edit" ? "Edit the task description."
          : hasMoreActions ? "Open More actions for other options." : "No action is available for this node.";

  function toggleEdit() {
    setDraft(task.description);
    setEditing((open) => !open);
  }

  function runPrimaryAction() {
    if (primaryAction === "landing") onRetryLanding?.(task.id);
    else if (primaryAction === "fix") setFixingForward((open) => !open);
    else if (primaryAction === "retry") onRetry?.(task.id);
    else if (primaryAction === "add") setAdding((open) => !open);
    else if (primaryAction === "edit") toggleEdit();
  }

  return (
    <Tabs.Root value={tab} onValueChange={setTab} asChild>
    <aside className="drawer feature-drawer swarm-node-drawer" role="dialog" aria-label={task.title} ref={panel} data-tab={tab}>
      <header className="drawer-head">
        <div className="feature-topline">
          <span className="feature-kicker">{task.nodeType === "leaf" ? "Swarm task" : "Plan node"}</span>
          <span className="status swarm-node-header-status">
            <span className="dot" data-state={diagramTaskTone(task.status, task.nodeType, node.agentActive)} />
            {diagramTaskWords(task.status, task.nodeType, node.agentActive)}
          </span>
          <button className="btn btn-ghost feature-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <h2 className="drawer-title">{task.title}</h2>
        {task.branchName && (
          <div className="feature-branch">
            <span className="meta-label">Branch</span>
            <code title={task.branchName}>{task.branchName}</code>
          </div>
        )}
        <div className="swarm-node-summary">
          <span className="swarm-drawer-progress">
            <CompletionRing fraction={node.completion} size={18} stroke={3} />
            {formatCompletion(node.completion)}
          </span>
          <span className="swarm-node-summary-divider" aria-hidden="true" />
          <span>{formatElapsed(node.elapsedMs)} elapsed</span>
          {attention && note && <span className="swarm-node-attention">{note}</span>}
        </div>
      </header>

      <Tabs.List className="feature-tabs swarm-node-tabs" aria-label="Swarm task details">
        <Tabs.Trigger value="overview">Actions and description</Tabs.Trigger>
        {task.nodeType === "leaf" && <Tabs.Trigger value="output">Worker logs</Tabs.Trigger>}
        <Tabs.Trigger value="commits">Commits</Tabs.Trigger>
        <Tabs.Trigger value="history">History</Tabs.Trigger>
      </Tabs.List>
      <div className="drawer-body feature-drawer-body swarm-node-body">
        <Tabs.Content value="overview" forceMount hidden={tab !== "overview"} className="feature-pane swarm-node-pane">
        {/*
         * Why this node is yellow, in a sentence with what to do about
         * it. The chip above has room for two words; this is the part
         * somebody who clicked a yellow node actually came for, and
         * without it every reason reads the same.
         */}
        {attention && longNote && (
          <p className="swarm-attention-note" role="status">
            {longNote}
          </p>
        )}

        <section className="section swarm-node-actions">
          <div className="feature-section-heading">
            <h3>{workerActive ? "Current activity" : "Next step"}</h3>
            {nextStep && <span>{nextStep}</span>}
          </div>
          {actionError && <p className="error-box" role="alert">{actionError}</p>}
          {primaryAction && (
            <div className="action-grid">
              <button className="btn btn-primary" type="button" disabled={busy} onClick={runPrimaryAction}>
                {primaryAction === "landing" ? "Retry merge queue"
                  : primaryAction === "fix" ? "Fix forward"
                  : primaryAction === "retry" ? (busy ? "Retrying worker…" : retries > 0 ? `Retry worker (${retries} so far)` : "Retry worker")
                  : primaryAction === "add" ? "Add task" : "Edit task"}
              </button>
            </div>
          )}
          {fixingForward && onFixForward && (
            <form className="swarm-edit" onSubmit={(event) => {
              event.preventDefault();
              const reason = fixReason.trim();
              if (!reason) return;
              onFixForward(task.id, reason);
              setFixingForward(false);
            }}>
              <label htmlFor="swarm-fix-reason">What should the worker fix?</label>
              <textarea id="swarm-fix-reason" className="input" rows={4} maxLength={4000} value={fixReason}
                onChange={(event) => setFixReason(event.target.value)} />
              <div className="actions">
                <button className="btn btn-ghost" type="button" onClick={() => setFixingForward(false)}>Cancel</button>
                <button className="btn btn-primary" type="submit" disabled={busy || !fixReason.trim()}>Start next attempt</button>
              </div>
            </form>
          )}
          <p className="swarm-node-cost-line">
            <span>Spend estimate</span>
            <strong>{formatUsd(cappedUsd(node.cost))}</strong>
            {node.childIds.length > 0 && <span className="muted">Includes tasks below</span>}
          </p>
          {hasMoreActions && (
            <details className="feature-more-actions">
              <summary>More actions</summary>
              <div className="action-grid">
                {canMarkDone && (
                  <button className="btn" type="button" disabled={busy} onClick={() => setConfirming(true)}>Mark done</button>
                )}
                {canRetry && primaryAction !== "retry" && (
                  <button className="btn" type="button" disabled={busy} title="Put this task back in the queue. The agent on it stops, and its report is cleared." onClick={() => onRetry?.(task.id)}>
                    {retries > 0 ? `Retry (${retries} so far)` : "Retry"}
                  </button>
                )}
                {canEdit && primaryAction !== "edit" && (
                  <button className="btn" type="button" disabled={busy} onClick={toggleEdit}>Edit task</button>
                )}
                {canSplit && (
                  <button className="btn" type="button" disabled={busy} title="Split this task into smaller tasks." onClick={() => setSplitting((open) => !open)}>Split task</button>
                )}
                {canAdd && primaryAction !== "add" && (
                  <button className="btn" type="button" disabled={busy} onClick={() => setAdding((open) => !open)}>{task.nodeType === "leaf" ? "Add dependent task" : "Add task"}</button>
                )}
              </div>
              {onReassign && task.nodeType === "leaf" && agents.length > 0 && (
                <label className="swarm-reassign">
                  <span className="meta-label">Worker agent</span>
                  <select
                    className="input"
                    value={task.agentProfileId ?? ""}
                    disabled={busy}
                    onChange={(e) => onReassign(task.id, e.target.value === "" ? null : e.target.value)}
                  >
                    <option value="">This swarm&apos;s own worker</option>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                </label>
              )}
              {canCancel && (
                <div className="danger-row">
                  <button className="btn btn-ghost btn-danger-quiet" type="button" disabled={busy} title="Withdraw this task and everything under it, and stop the agents on them." onClick={() => onCancel?.(task.id)}>Cancel task</button>
                </div>
              )}
              {task.nodeType !== "leaf" && <p className="muted">A plan node is finished by its own tasks finishing.</p>}
              {canMarkDone && <p className="muted">Marking this done stops its worker and counts it as finished.</p>}
            </details>
          )}

          {editing && onEdit && (
            <form
              className="swarm-edit"
              onSubmit={(e) => {
                e.preventDefault();
                onEdit(task.id, { description: draft });
                setEditing(false);
              }}
            >
              <textarea
                className="input"
                rows={4}
                value={draft}
                aria-label="What this task is"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="actions">
                <button className="btn btn-ghost" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Save
                </button>
              </div>
            </form>
          )}

          {splitting && onSplit && (
            <form
              className="swarm-edit"
              onSubmit={(e) => {
                e.preventDefault();
                const children = splitText
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
                  .map((title) => ({ title }));
                if (children.length === 0) return;
                onSplit(task.id, children);
                setSplitText("");
                setSplitting(false);
              }}
            >
              <textarea
                className="input"
                rows={4}
                value={splitText}
                placeholder="One task per line"
                aria-label="The tasks to split this into"
                onChange={(e) => setSplitText(e.target.value)}
              />
              <div className="actions">
                <button className="btn btn-ghost" type="button" onClick={() => setSplitting(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy || splitText.trim() === ""}>
                  Split
                </button>
              </div>
            </form>
          )}
          {adding && onAddTask && (
            <form
              className="swarm-edit"
              onSubmit={(e) => {
                e.preventDefault();
                const title = addTitle.trim();
                if (title === "") return;
                onAddTask(task.id, { title, ...(addDetail.trim() ? { description: addDetail.trim() } : {}) });
                setAddTitle("");
                setAddDetail("");
                setAdding(false);
              }}
            >
              <input
                className="input"
                value={addTitle}
                placeholder="What the task is"
                aria-label="The task's title"
                onChange={(e) => setAddTitle(e.target.value)}
              />
              <textarea
                className="input"
                rows={3}
                value={addDetail}
                placeholder="What finished means for it"
                aria-label="What finished means for this task"
                onChange={(e) => setAddDetail(e.target.value)}
              />
              <p className="muted">
                {task.nodeType === "leaf"
                  ? "A worker starts after this task finishes. The planner will be notified."
                  : "A worker starts when one is available. The planner will be notified."}
              </p>
              <div className="actions">
                <button className="btn btn-ghost" type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy || addTitle.trim() === ""}>
                  Add task
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="section">
          <span className="label">Description</span>
          {task.description ? (
            <p className="swarm-text">{task.description}</p>
          ) : (
            <p className="muted">The planner left this one to its title.</p>
          )}
        </section>

        <section className="section">
          <span className="label">Acceptance criteria</span>
          {task.acceptanceCriteria.length > 0 ? (
            <ul className="swarm-criteria">
              {task.acceptanceCriteria.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">None set. The worker is judged on the description alone.</p>
          )}
        </section>

        {task.report && (
          <section className="section">
            <span className="label">Report</span>
            <Markdown text={task.report} />
          </section>
        )}

        {flags.length > 0 && (
          <section className="section">
            <span className="label">Flags</span>
            <ul className="swarm-flags">
              {flags.map(([key, value]) => (
                <li key={key}>
                  <span className="swarm-flag-key">{key}</span>
                  <span className="swarm-flag-value">{describeFlag(value)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        </Tabs.Content>

        {task.nodeType === "leaf" && (
          <Tabs.Content value="output" forceMount hidden={tab !== "output"} className="feature-pane swarm-node-pane swarm-output-pane">
            <section className="section">
              <span className="label">Worker logs</span>
              {mergeQueueFailure && (
                <div className="swarm-failure-detail" role="status">
                  <strong>{MERGE_QUEUE_FAILURE}</strong>
                  <p>The worker finished its attempt. Its branch could not be landed on the swarm branch.</p>
                  <details><summary>Technical details</summary><pre>{String(task.flags.landingError)}</pre></details>
                </div>
              )}
              {transcript ?? <p className="muted">Worker logs will appear here when this task starts.</p>}
            </section>
          </Tabs.Content>
        )}

        <Tabs.Content value="commits" forceMount hidden={tab !== "commits"} className="feature-pane swarm-node-pane">

        <section className="section">
          <span className="label">Commits</span>
          {commits.length > 0 ? (
            <ul className="swarm-commits">
              {commits.map((commit) => (
                <li key={`${commit.repository ?? ""}${commit.sha}`}>
                  <span className="chip swarm-sha">{commit.sha.slice(0, 7)}</span>
                  {/* Named only when a project spans more than one, so
                      the ordinary case is not a column of the same word. */}
                  {commit.repository && repositoriesNamed > 1 && (
                    <span className="chip chip-clip">{commit.repository}</span>
                  )}
                  <span className="swarm-commit-message">{commit.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No commits carry this task&apos;s trailer yet. They appear here once its agent has
              committed, and stay after the branch lands.
            </p>
          )}
        </section>

        </Tabs.Content>

        <Tabs.Content value="history" forceMount hidden={tab !== "history"} className="feature-pane swarm-node-pane">

        {runs.length > 0 && (
          <section className="section">
            <span className="label">Worker attempts</span>
            <ol className="swarm-attempts">
              {runs.map((run, index) => (
                <li key={run.id} className="swarm-attempt">
                  <div className="swarm-attempt-main">
                    <strong>Attempt {runs.length - index}</strong>
                    <span className="status"><span className="dot" data-state={run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "running"} />{run.status}</span>
                    <time dateTime={run.queuedAt}>{new Date(run.queuedAt).toLocaleString()}</time>
                  </div>
                  {run.error && <p className="swarm-attempt-error">{run.error}</p>}
                  {onOpenRun && <button className="swarm-output-link" type="button" onClick={() => onOpenRun(run.id)}>View output</button>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {events.length > 0 && (
          <section className="section">
            <span className="label">History</span>
            {/*
             * What has happened to this node, resolver runs included: a
             * conflict puts a second agent on a leaf, and this is the
             * only place on the node that says so. Every value here is
             * rendered as text, because a `detail` is written by the
             * coordinator and by agents alike.
             */}
            <ul className="swarm-events">
              {events.map((event, index) => {
                const at = new Date(event.at);
                const previous = index > 0 ? new Date(events[index - 1]!.at) : null;
                const day = at.toDateString();
                const note = eventNote(event);
                return (
                  <Fragment key={event.id}>
                    {day !== previous?.toDateString() && (
                      <li className="swarm-event-day">{at.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</li>
                    )}
                    <li className="swarm-event" data-kind={event.kind} data-state={event.toStatus ?? undefined}>
                      <span className="swarm-event-marker" aria-hidden="true" />
                      <div className="swarm-event-content">
                        <div className="swarm-event-main">
                          <strong>{eventWords(event)}</strong>
                          <time dateTime={event.at} title={at.toLocaleString()}>{at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
                        </div>
                        {(note || event.runId) && (
                          <div className="swarm-event-detail">
                            {note && <span className="swarm-event-note" title={note}>{note}</span>}
                            {event.runId && <code>run {event.runId.slice(0, 8)}</code>}
                          </div>
                        )}
                      </div>
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          </section>
        )}

        {runs.length === 0 && events.length === 0 && <p className="muted">No history yet.</p>}
        </Tabs.Content>

      </div>

      {confirming && (
        <div className="swarm-confirm" role="alertdialog" aria-label="Mark this task done">
          <p>
            Marking this done counts its weight towards every plan above it, and towards the
            swarm&apos;s own ring.
          </p>
          <div className="actions">
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setConfirming(false);
                onMarkDone?.(task.id);
              }}
            >
              Mark done
            </button>
          </div>
        </div>
      )}
    </aside>
    </Tabs.Root>
  );
}

/** The heading for one node event, in words rather than in its enum. */
export function eventWords(event: SwarmTaskEvent): string {
  switch (event.kind) {
    case "created":
      return "Task created";
    case "assigned":
      return "Worker started";
    case "status_changed":
      // A retry carrying a reason with a run on it is the planner's
      // reject: the reason is what it told the next worker.
      if (event.toStatus === "assigned" && typeof event.detail?.rejection === "string" && event.runId) {
        return "Planner sent it back";
      }
      if (event.toStatus === "assigned") return "Queued for worker";
      if (event.toStatus === "failed") return "Worker failed";
      return event.toStatus ? `Now ${event.toStatus}` : "Status changed";
    case "reported":
      return "Worker reported";
    case "review_requested":
      return "Planner reviewing";
    case "review_interrupted":
      return "Planner review interrupted";
    case "attention_raised":
      // The one an agent other than this node's worker produces: a
      // conflict, with a resolver put on it.
      return event.detail?.resolver === "started" ? "Resolver started" : "Needs attention";
    case "landed":
      return "Landed";
    case "note":
      return event.detail?.accepted === true ? "Planner accepted" : "Note";
    default:
      return event.kind;
  }
}

/**
 * The note under one event's heading.
 *
 * Agent written and coordinator written values alike, so it is text.
 * A run id is printed separately so repeated attempts are easy to scan.
 */
export function eventNote(event: SwarmTaskEvent): string {
  const detail = event.detail ?? {};
  const said =
    typeof detail.conflict === "string"
      ? detail.conflict
      : typeof detail.note === "string"
        ? detail.note
        : typeof detail.landingError === "string"
          ? detail.landingError
          : typeof detail.landingFailed === "string"
            ? detail.landingFailed
            : typeof detail.rejection === "string"
              ? detail.rejection
              : "";
  const firstLine = said.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return firstLine;
}

/**
 * A flag's value as text.
 *
 * Coordinator bookkeeping is loosely typed by design, and an agent
 * decides what goes in it. Stringified rather than rendered, so a
 * flag holding an object is a readable line instead of React
 * refusing to draw the drawer.
 */
export function describeFlag(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "unreadable";
  }
}
