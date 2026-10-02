import { useEffect, useState } from "react";
import type { SwarmLanding, SwarmTask } from "../swarm/types.js";
import { MERGE_QUEUE_FAILURE } from "../swarm/failures.js";

/**
 * The merge queue, as a person needs to read it.
 *
 * A swarm's branch is one branch and its leaves are many, so the
 * question this panel answers is the one nothing else on the page can:
 * whose work is actually in, and what is holding up the rest. The tree
 * says a leaf is done; it does not say that the leaf behind it has been
 * waiting eleven minutes because a conflict at the front has not been
 * resolved.
 *
 * Three groups, in the order they matter. What is landing now, because
 * it is the only row anything is happening to. What is waiting, because
 * that is the queue. And what has landed, newest first, because the
 * last few are how a person checks that the queue is moving at all.
 *
 * Everything an agent or git wrote is printed as text. A landing's
 * error is git's own words about somebody's code, which is the shape
 * of thing that carries a payload.
 */

/**
 * The words each landing status is drawn in, and the hue behind them.
 *
 * The tones are the board's own, not a set of this panel's: a queue row
 * that is landing should be the same blue as a task that is working,
 * and a conflict the same yellow as everything else that wants a
 * person. A name the stylesheet does not define draws as no colour at
 * all, silently, which is how a status with its own vocabulary becomes
 * a row people cannot tell apart from the one above it.
 */
const WORDS: Record<SwarmLanding["status"], { label: string; tone: string }> = {
  landing: { label: "Landing", tone: "running" },
  queued: { label: "Waiting", tone: "idle" },
  landed: { label: "Committed", tone: "succeeded" },
  conflicted: { label: "Conflict", tone: "gated" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Withdrawn", tone: "cancelled" },
};

/** How many landed rows are worth keeping on screen. */
const HISTORY = 10;

/** The local OrbStack HTTP origin may not expose the Clipboard API. */
async function copyBranchName(branchName: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(branchName);
      return;
    } catch {
      // A browser can expose the API but still refuse this origin.
    }
  }

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = branchName;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard access was denied");
  } finally {
    field.remove();
    previousFocus?.focus();
  }
}

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function MergeQueue({
  landings,
  summary,
  destination,
  swarmDone,
  checkout,
  onReleaseBranch,
  busy,
  tasks,
  selectedId,
  onSelect,
}: {
  landings: SwarmLanding[];
  summary?: { total: number; committed: number };
  destination?: string | null;
  swarmDone?: boolean;
  checkout?: { mode: "worktree" | "remote"; released: boolean };
  onReleaseBranch?: () => void;
  busy?: boolean;
  tasks: SwarmTask[];
  selectedId?: string | null;
  onSelect?: (taskId: string) => void;
}) {
  const [commandCopyState, setCommandCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (commandCopyState === "idle") return;
    const timer = setTimeout(() => setCommandCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [commandCopyState]);
  async function copyCommand() {
    if (!destination) return;
    try {
      await copyBranchName(`git switch ${destination}`);
      setCommandCopyState("copied");
    } catch {
      setCommandCopyState("failed");
    }
  }
  const counts = summary ?? {
    total: landings.length,
    committed: landings.filter((landing) => landing.status === "landed").length,
  };
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const inFlight = landings.filter((landing) => landing.status === "landing" || landing.status === "conflicted");
  const waiting = landings.filter((landing) => landing.status === "queued");
  /**
   * Newest first, which is the opposite of the queue's own order: a
   * queue is read from its front and a history is read from its end.
   * Sorted by when each ended rather than by position, because a
   * landing that was retried keeps its place in the queue and is
   * nonetheless the most recent thing that happened.
   */
  const finished = landings
    .filter((landing) => landing.status === "landed" || landing.status === "failed" || landing.status === "cancelled")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, HISTORY);

  if (landings.length === 0) {
    return (
      <section className="swarm-queue" aria-label="Merge queue">
        <header className="swarm-queue-head">
          <h2>Merge queue</h2>
        </header>
        <p className="muted swarm-queue-empty">
          No branches yet. Accepted work appears here before it is committed to the swarm branch.
        </p>
      </section>
    );
  }

  return (
    <section className="swarm-queue" aria-label="Merge queue">
      <header className="swarm-queue-head">
        <h2>Merge queue</h2>
        <span className="muted swarm-queue-branches-heading">
          {waiting.length === 0
            ? "Branches"
            : `Branches: ${waiting.length} waiting`}
        </span>
      </header>

      {destination && counts.total > 0 && (
        <div className="swarm-queue-destination">
          <p>
            <strong>{counts.committed === counts.total
              ? `All ${counts.committed} task branches committed`
              : `${counts.committed} of ${counts.total} task branches committed`}</strong>
            <span className="muted"> to </span>
            <code>{destination}</code>
          </p>
          {checkout?.mode === "worktree" && swarmDone && (
            checkout.released ? (
              <div className="swarm-queue-checkout">
                <span>Ready to check out:</span>
                <code>git switch {destination}</code>
                <button type="button" className="swarm-queue-command-copy" data-copy-state={commandCopyState}
                  aria-label="Copy checkout command" onClick={() => void copyCommand()}>
                  <CopyIcon copied={commandCopyState === "copied"} />
                  <span className="visually-hidden" aria-live="polite">
                    {commandCopyState === "copied" ? "Copied" : commandCopyState === "failed" ? "Copy failed" : ""}
                  </span>
                </button>
              </div>
            ) : (
              <button type="button" className="btn" disabled={busy || !onReleaseBranch} onClick={onReleaseBranch}>
                Release branch for checkout
              </button>
            )
          )}
        </div>
      )}

      <ul className="swarm-queue-list">
        {[...inFlight, ...waiting, ...finished].map((landing) => (
          <Row
            key={landing.id}
            landing={landing}
            title={titles.get(landing.taskId) ?? "a task that is no longer in the plan"}
            selected={selectedId === landing.taskId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  landing,
  title,
  selected,
  onSelect,
}: {
  landing: SwarmLanding;
  title: string;
  selected: boolean;
  onSelect?: (taskId: string) => void;
}) {
  const words = WORDS[landing.status];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyBranch() {
    if (!landing.branchName) return;
    try {
      await copyBranchName(landing.branchName);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <li className="swarm-queue-row" data-state={words.tone} data-on={selected ? "" : undefined}>
      <div className="swarm-queue-row-top">
        <button
          type="button"
          className="swarm-queue-row-main"
          onClick={() => onSelect?.(landing.taskId)}
          disabled={!onSelect}
        >
          <span className="status">
            <span className="dot" data-state={words.tone} />
            {words.label}
          </span>
          {/* Agent written, so text and only text. */}
          <span className="swarm-queue-title swarm-text">{title}</span>
          {landing.attempt > 1 && (
            <span className="chip" title="Times the merge queue has tried to add this branch to the swarm branch. The worker is not rerun.">
              Merge attempt {landing.attempt}
            </span>
          )}
        </button>
        {landing.branchName && (
          <button
            type="button"
            className="swarm-queue-copy"
            data-copy-state={copyState}
            aria-label={`Copy branch name ${landing.branchName}`}
            onClick={() => void copyBranch()}
          >
            <span className="chip chip-clip">{landing.branchName}</span>
            <span className="swarm-queue-copy-icon" aria-hidden="true">
              <CopyIcon copied={copyState === "copied"} />
            </span>
            <span className="visually-hidden" aria-live="polite">
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : ""}
            </span>
          </button>
        )}
      </div>
      {landing.status === "failed" && <p className="swarm-queue-note">{MERGE_QUEUE_FAILURE}</p>}
      {landing.error && landing.status === "failed" && (
        <details className="swarm-queue-technical"><summary>Technical details</summary><pre className="swarm-queue-error swarm-text">{landing.error}</pre></details>
      )}
      {landing.error && landing.status !== "landed" && landing.status !== "failed" && (
        /*
         * What git said, verbatim and as text. It is the only thing
         * that tells somebody whether a conflict is theirs to settle or
         * one the resolver will take, and paraphrasing it would lose
         * the file names that make it answerable.
         */
        <pre className="swarm-queue-error swarm-text">{landing.error}</pre>
      )}
      {landing.status === "conflicted" && (
        /*
         * Two sentences, because a conflict with nobody on it is not
         * the same situation as one being worked, and the words used to
         * say the queue had given up on it. It has not: an agent is
         * asked for on every pass, and the ordinary reason there is
         * none yet is that the team has no agent hours left for the
         * moment.
         */
        <p className="muted swarm-queue-note">
          {landing.resolverRunId
            ? "An agent is reconciling this branch with the swarm's branch. Nothing else lands until it is settled."
            : "No agent is on this branch yet. One is asked for each time the swarm is reconciled, and nothing else lands until this is settled."}
        </p>
      )}
    </li>
  );
}
