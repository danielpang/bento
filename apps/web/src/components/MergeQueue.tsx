import type { SwarmLanding, SwarmTask } from "../swarm/types.js";

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
  landed: { label: "Landed", tone: "succeeded" },
  conflicted: { label: "Conflict", tone: "gated" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Withdrawn", tone: "cancelled" },
};

/** How many landed rows are worth keeping on screen. */
const HISTORY = 10;

export function MergeQueue({
  landings,
  tasks,
  selectedId,
  onSelect,
}: {
  landings: SwarmLanding[];
  tasks: SwarmTask[];
  selectedId?: string | null;
  onSelect?: (taskId: string) => void;
}) {
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
          <span className="label">Merge queue</span>
        </header>
        <p className="muted swarm-queue-empty">
          Nothing has been accepted yet. A leaf joins the queue when the planner accepts its work, and the queue lands
          one branch at a time onto the swarm's branch.
        </p>
      </section>
    );
  }

  return (
    <section className="swarm-queue" aria-label="Merge queue">
      <header className="swarm-queue-head">
        <span className="label">Merge queue</span>
        <span className="muted">
          {waiting.length === 0
            ? "one branch at a time"
            : `${waiting.length} waiting, one branch at a time`}
        </span>
      </header>

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
  return (
    <li className="swarm-queue-row" data-state={words.tone} data-on={selected ? "" : undefined}>
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
        {landing.branchName && (
          <span className="chip chip-clip" title={landing.branchName}>
            {landing.branchName}
          </span>
        )}
        {landing.attempt > 1 && (
          <span className="chip" title="How many times this branch has been tried">
            try {landing.attempt}
          </span>
        )}
      </button>
      {landing.error && landing.status !== "landed" && (
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
