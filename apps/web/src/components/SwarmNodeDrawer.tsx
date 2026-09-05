import { useState, type ReactNode } from "react";
import { Markdown } from "./Markdown.js";
import { CompletionRing } from "./CompletionRing.js";
import { useDismissable } from "./ui.js";
import { attentionWords, isAttention, taskTone, taskWords } from "../swarm/status.js";
import { formatCompletion, type SwarmNode } from "../swarm/layout.js";
import { spendParts, formatUsd } from "../swarm/money.js";
import { formatElapsed } from "../swarm/time.js";
import type { SwarmTask } from "../swarm/types.js";

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
  onClose,
  onMarkDone,
  transcript,
  busy,
}: {
  task: SwarmTask;
  /** The rolled up figures for this node, from the shared model. */
  node: SwarmNode;
  onClose: () => void;
  /**
   * Marks a leaf done by hand.
   *
   * Optional, and absent is the answer today: no route finishes a task
   * on somebody's say so, so the button is drawn disabled with the
   * reason under it rather than wired to something that would look
   * like it worked and do nothing.
   */
  onMarkDone?: (taskId: string) => void;
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
          {task.commits.length > 0 ? (
            <ul className="swarm-commits">
              {task.commits.map((commit) => (
                <li key={commit.sha}>
                  <span className="chip swarm-sha">{commit.sha.slice(0, 7)}</span>
                  <span className="swarm-commit-message">{commit.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing pushed on this branch yet.</p>
          )}
        </section>

        <section className="section">
          <span className="label">Worker</span>
          {transcript ?? (
            <p className="muted">
              No worker has been on this task yet. The conversation appears here once one starts.
            </p>
          )}
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
            <p className="muted">
              Finishing a task by hand is not available yet. A leaf is done when its worker reports
              and the planner accepts it.
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
