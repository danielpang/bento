import type { NodeType, SwarmStatus, TaskAttention, TaskStatus } from "./types.js";

/**
 * What a status looks like, and what it is called.
 *
 * The console has five reserved hues and no more: blue is running,
 * green succeeded, coral failed, gold wants a person, grey is idle.
 * A swarm introduces no sixth colour, so every swarm and task status
 * resolves to one of those five here, once, and both views read the
 * answer from this module.
 *
 * Attention is deliberately not in that mapping. A worker that has
 * been going for an hour is still `working`, and a leaf asking a
 * question is still whatever it was doing: the yellow is painted over
 * the status rather than instead of it, which is why the two are
 * separate functions and why switching from Tree to Outline cannot
 * lose it.
 */
export type Tone = "running" | "succeeded" | "failed" | "gated" | "idle";

const BUDGET_LIMIT_LABEL = "Budget limit reached";
const BUDGET_LIMIT_WARNING = "This swarm has reached its budget limit. Raise the limit to start more agents. Work already committed stays on the branch.";
const TIME_LIMIT_WARNING = "This swarm reached its time limit. Work already committed stays on the branch. Raise the limit to continue.";
const AGENT_HOURS_WARNING = "This team has used all of its agent hours. New agents will start when more hours are available.";

/** A task's own status as one of the five hues. Attention is not consulted. */
export function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case "assigned":
    case "working":
    // Landed is merged but not finished: the leaf is still in motion,
    // and only `done` is allowed to be the green that the ring counts.
    case "landed":
      return "running";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "blocked":
      return "gated";
    default:
      return "idle";
  }
}

/** The strip's dot, and the header's chip. */
export function swarmTone(status: SwarmStatus): Tone {
  switch (status) {
    case "planning":
    case "running":
      return "running";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    // Three different reasons to want a person, one hue: a swarm that
    // is paused, one holding a question, and one that has spent its
    // budget all need somebody before anything else happens.
    case "paused":
    case "waiting":
    case "budget_exhausted":
    case "timed_out":
      return "gated";
    default:
      return "idle";
  }
}

/** What a swarm's status is called, in words a person would use. */
export function swarmWords(status: SwarmStatus): string {
  switch (status) {
    case "planning":
      return "planning";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "waiting":
      return "waiting for you";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "budget_exhausted":
      return BUDGET_LIMIT_LABEL;
    case "timed_out":
      return "out of time";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

/** What a task's status is called. */
export function taskWords(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "open";
    case "assigned":
      return "assigned";
    case "working":
      return "working";
    case "landed":
      return "landed";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

/** A failed group can still recover when its failed descendant is retried. */
export function diagramTaskWords(status: TaskStatus, nodeType: NodeType): string {
  return nodeType === "plan" && status === "failed" ? "stalled" : taskWords(status);
}

export function diagramTaskTone(status: TaskStatus, nodeType: NodeType): Tone {
  return nodeType === "plan" && status === "failed" ? "gated" : taskTone(status);
}

/** Do not print the same failure twice on a leaf. */
export function diagramAttentionWords(status: TaskStatus, nodeType: NodeType, attention: TaskAttention): string | null {
  const words = attentionWords(attention);
  return words === diagramTaskWords(status, nodeType) ? null : words;
}

/**
 * The second axis, in words. Null when nothing is asking for anybody,
 * which is most of the tree most of the time.
 *
 * One sentence per reason, because the reasons are what a person acts
 * on. They all used to read "needs you", which is true of all of them
 * and useful about none: a merge conflict wants a resolver, a question
 * wants an answer, and a swarm out of budget wants a decision about
 * money. The colour stays one colour.
 */
export function attentionWords(attention: TaskAttention): string | null {
  switch (attention) {
    case "long_running":
      return "Still running";
    case "escalated":
      return "Planner notified of long run task";
    case "question":
      return "Waiting for user approval";
    case "failed":
      return "failed";
    case "conflict":
      return "Merge conflict";
    case "budget":
      return BUDGET_LIMIT_LABEL;
    case "plan_limit":
      return "Out of Bento agent hours, enable overage billing to continue";
    default:
      return null;
  }
}

/**
 * The longer sentence, for the drawer and for a node's tooltip.
 *
 * The chip has room for two words and this has room for what to do
 * about it, which is the part somebody opening a yellow node came for.
 */
export function attentionNote(attention: TaskAttention): string | null {
  switch (attention) {
    case "long_running":
      return "The agent has been running past the warning threshold. Check worker logs to verify.";
    case "escalated":
      return "This agent is taking longer than expected. The planner has been notified. Check the logs for progress.";
    case "question":
      return "Planner is waiting for user response before continuing.";
    case "failed":
      return "The worker failed. Retry the task to start another attempt.";
    case "conflict":
      return "This branch cannot be merged yet. An agent will try to resolve the conflict. If it conflicts again, the task will fail.";
    case "budget":
      return BUDGET_LIMIT_WARNING;
    case "plan_limit":
      return AGENT_HOURS_WARNING;
    default:
      return null;
  }
}

/**
 * Whether this node is drawn yellow.
 *
 * One question, asked the same way by the tree, by the outline, and
 * by the drawer, so a leaf cannot be yellow in one view and plain in
 * the next.
 */
export function isAttention(attention: TaskAttention): boolean {
  return attention !== "none";
}

/** Whether a swarm is finished with, for the strip's overflow and the header. */
export function isSwarmOver(status: SwarmStatus): boolean {
  return status === "done" || status === "stopped" || status === "failed";
}

/**
 * Why a swarm is not starting anything, in a sentence, or null.
 *
 * The header's own line. A swarm that has stopped moving is the moment
 * a person most needs to be told which of four different things
 * happened, and "paused" on its own says none of them.
 */
export function pausedWords(
  status: SwarmStatus,
  reason: "manual" | "budget" | "time_limit" | "attention" | "plan_limit" | "error" | null,
): string | null {
  if (status === "budget_exhausted") {
    return BUDGET_LIMIT_WARNING;
  }
  if (status === "timed_out") {
    return TIME_LIMIT_WARNING;
  }
  if (status !== "paused") return null;
  switch (reason) {
    case "plan_limit":
      return AGENT_HOURS_WARNING;
    case "budget":
      return BUDGET_LIMIT_WARNING;
    case "time_limit":
      return TIME_LIMIT_WARNING;
    case "attention":
      return "Something in this swarm is waiting on you.";
    case "error":
      return "This swarm stopped on an error. Its plan and everything that landed are still here.";
    default:
      return "This swarm is paused. Resume it to continue.";
  }
}

/**
 * Whether pausing, stopping, and the worker stepper do anything.
 *
 * A finished swarm keeps its buttons visible and disabled rather than
 * losing them: a control that disappears reads as a console that
 * forgot the swarm, and a disabled one says the swarm is over.
 */
export function canPause(status: SwarmStatus): boolean {
  return status === "planning" || status === "running" || status === "waiting";
}

export function canResume(status: SwarmStatus): boolean {
  return status === "paused" || status === "budget_exhausted" || status === "timed_out";
}

/**
 * Whether Start is offered: a swarm that has been planned and not yet
 * set going.
 *
 * Its own question rather than a third value of canResume, because a
 * swarm being planned is also a swarm somebody can pause, so the
 * control sits beside Pause instead of taking its place. Without it a
 * freshly planned swarm had no way to be started at all: every door
 * the console has for starting work was behind canResume, which a
 * planning swarm is not.
 *
 * Offered whether or not the plan has arrived. Whether there is
 * anything to start is the route's answer (it refuses a swarm with an
 * empty tree, in words), and a button that says nothing is worse than
 * a refusal that says why.
 */
export function canStart(status: SwarmStatus): boolean {
  return status === "planning";
}

export function canStop(status: SwarmStatus): boolean {
  return !isSwarmOver(status);
}

/**
 * Whether Reopen is offered.
 *
 * Every ending, and only an ending. A reopen adds work to a swarm that
 * has finished and published, on the branch its pull request is open
 * on; offering it on a swarm that is still running would be a second
 * way of doing what sending the planner a message already does, with
 * a follow up node nobody asked for as the side effect.
 *
 * The two ceilings are here as well as in canResume, and the two
 * controls mean different things: Resume asks a swarm to carry on with
 * the plan it already has, and Reopen adds something to it. A swarm
 * that ran out of money can want either.
 */
export function canReopen(status: SwarmStatus): boolean {
  return isSwarmOver(status) || status === "budget_exhausted" || status === "timed_out";
}
