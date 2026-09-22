import { useState, type ReactNode } from "react";
import { Markdown } from "./Markdown.js";
import { CompletionRing } from "./CompletionRing.js";
import { useDismissable } from "./ui.js";
import { attentionWords, isAttention, taskTone, taskWords } from "../swarm/status.js";
import { formatCompletion, type SwarmNode } from "../swarm/layout.js";
import { spendParts, formatUsd } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";
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
  onMessage,
  transcript,
  busy,
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
   * nothing to send it to. A drawer given no handler draws the button
   * disabled with the reason under it, rather than wired to something
   * that would look like it worked and do nothing.
   */
  onMarkDone?: (taskId: string) => void;
  /**
   * Sends a message to the agent on this node.
   *
   * Optional for the reason marking done is: a caller with no swarm
   * selected has nowhere to send it, and a composer wired to nothing
   * is worse than no composer.
   */
  onMessage?: (taskId: string, text: string) => void;
  /**
   * The worker's conversation.
   *
   * The console already has one of these: `AgentSession`, the same
   * transcript and composer the card drawer and the session page
   * render. It is passed in rather than built again here, and stays
   * empty until runs are keyed by swarm task and the run routes
   * answer for them.
   */
  transcript?: ReactNode;
  busy?: boolean;
}) {
  const panel = useDismissable<HTMLElement>(onClose);
  const [confirming, setConfirming] = useState(false);
  const attention = isAttention(task.attention);
  const note = attentionWords(task.attention);
  const flags = Object.entries(task.flags);
  // The fetched list when there is one, and the plan row's otherwise.
  // A fetched empty list is an answer, not a missing one, so the
  // fallback is on the detail being absent rather than on it being
  // empty.
  const commits = detail ? detail.commits : task.commits;
  const events = detail?.events ?? [];

  return (
    <aside className="drawer" role="dialog" aria-label={task.title} ref={panel}>
      <header className="drawer-head">
        <div className="drawer-title-row">
          <h2 className="drawer-title">{task.title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="drawer-meta">
          <div className="meta-item">
            <span className="meta-label">Progress</span>
            <span className="swarm-drawer-progress">
              <CompletionRing fraction={node.completion} size={18} stroke={3} />
              {formatCompletion(node.completion)}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="status">
              <span className="dot" data-state={taskTone(task.status)} />
              {taskWords(task.status)}
            </span>
          </div>
          {attention && note && (
            <div className="meta-item">
              <span className="meta-label">Attention</span>
              <span className="chip swarm-attention-chip">{note}</span>
            </div>
          )}
          <div className="meta-item">
            <span className="meta-label">Elapsed</span>
            <span className="chip">{formatElapsed(node.elapsedMs)}</span>
          </div>
          {task.branchName && (
            <div className="meta-item meta-item-wide">
              <span className="meta-label">Branch</span>
              <span className="chip chip-clip" title={task.branchName}>
                {task.branchName}
              </span>
            </div>
          )}
        </div>
      </header>

      <div className="drawer-body drawer-body-sectioned">
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

        <section className="section">
          <span className="label">Spend</span>
          {/* Three figures, three confidences, never one total. */}
          <ul className="swarm-tiers">
            {spendParts(node.cost).map((part) => (
              <li key={part.tier} title={part.note}>
                <span className="swarm-tier-label">{part.label}</span>
                <span className="swarm-tier-value spend-figure">{formatUsd(part.usd)}</span>
              </li>
            ))}
          </ul>
          {node.childIds.length > 0 && (
            <p className="muted">Rolled up from every task under this one.</p>
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
              {events.map((event) => (
                <li key={event.id}>
                  <span className="chip">{eventWords(event)}</span>
                  <span className="swarm-event-note">{eventNote(event)}</span>
                  <span className="muted swarm-event-at">{new Date(event.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="section">
          <span className="label">Worker</span>
          {transcript ?? (
            <p className="muted">
              No worker has been on this task yet. The conversation appears here once one starts.
            </p>
          )}
          {onMessage && <WorkerComposer task={task} busy={busy} onSend={(text) => onMessage(task.id, text)} />}
        </section>

        <section className="section">
          <span className="label">Actions</span>
          <div className="actions">
            {/* The confirmation is not ceremony: marking done moves
                every ring above it, up to the one on the tab. */}
            <button
              className="btn"
              disabled={!onMarkDone || busy || task.status === "done" || task.nodeType !== "leaf"}
              onClick={() => setConfirming(true)}
            >
              Mark done
            </button>
          </div>
          {task.nodeType !== "leaf" && (
            <p className="muted">A plan node is finished by its own tasks finishing.</p>
          )}
          {onMarkDone === undefined && task.nodeType === "leaf" && (
            <p className="muted">Finishing a task by hand is not available here.</p>
          )}
          {onMarkDone !== undefined && task.nodeType === "leaf" && task.status !== "done" && (
            <p className="muted">
              A leaf is normally done when its worker reports and the planner accepts it. Finishing
              it here says so on their behalf, and stops any agent still working it.
            </p>
          )}
        </section>
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
  );
}

/**
 * The box for saying something to the agent on one node.
 *
 * The card composer's rule is that the box says whether the words go
 * now or wait, because a person who does not know cannot tell a
 * message that was read from one that was not. A swarm's worker is the
 * furthest end of that scale: it is headless, it holds no live
 * session, and nothing can reach it between the moment it starts and
 * the moment it reports. So what this box promises is the honest
 * thing, which is that the message is given to the next agent put on
 * this task.
 *
 * A finished task gets no box at all. There is no next agent, and a
 * composer over a done node is exactly the control that looks like it
 * worked and did nothing.
 */
export function WorkerComposer({
  task,
  busy,
  onSend,
}: {
  task: SwarmTask;
  busy?: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  if (task.status === "done" || task.status === "cancelled") {
    return (
      <p className="muted">
        This task is finished, so no agent is coming to read a message. Send one from a task that is
        still open.
      </p>
    );
  }
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    onSend(trimmed);
  };
  return (
    <div className="swarm-composer">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="input composer-input"
          rows={1}
          value={text}
          disabled={busy}
          placeholder="Queue a message..."
          aria-label="Queue a message for this task"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter is the newline, as in the
            // card composer, so the two boxes behave the same way.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn btn-primary composer-send"
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Queue a message for this task"
        >
          Send
        </button>
      </form>
      <p className="muted composer-hint">
        {task.status === "working"
          ? "An agent is working this task and cannot hear mid turn. Your message is given to the next agent put on it, which is the one that can act on it."
          : "Your message is given to the agent that picks this task up."}
      </p>
    </div>
  );
}

/** The heading for one node event, in words rather than in its enum. */
export function eventWords(event: SwarmTaskEvent): string {
  switch (event.kind) {
    case "created":
      return "Created";
    case "assigned":
      return "Assigned";
    case "status_changed":
      return event.toStatus ? `Now ${event.toStatus}` : "Status changed";
    case "attention_raised":
      // The one an agent other than this node's worker produces: a
      // conflict, with a resolver put on it.
      return event.detail?.resolver === "started" ? "Resolver started" : "Needs attention";
    case "landed":
      return "Landed";
    case "note":
      return "Note";
    default:
      return event.kind;
  }
}

/**
 * The sentence under one event's heading.
 *
 * Agent written and coordinator written values alike, so it is text.
 * A run id is printed when there is one, because a resolver run is
 * otherwise invisible on the node it served.
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
            : "";
  const run = event.runId ? `run ${event.runId.slice(0, 8)}` : "";
  const firstLine = said.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return [firstLine, run].filter((part) => part !== "").join(" · ");
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
