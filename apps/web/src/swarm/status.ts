import type { SwarmStatus, TaskAttention, TaskStatus } from "./types.js";

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
      return "out of budget";
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

/**
 * The second axis, in words. Null when nothing is asking for anybody,
 * which is most of the tree most of the time.
 */
export function attentionWords(attention: TaskAttention): string | null {
  if (attention === "long_running") return "running long";
  if (attention === "escalated") return "needs you";
  return null;
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
  return status === "paused" || status === "budget_exhausted";
}

export function canStop(status: SwarmStatus): boolean {
  return !isSwarmOver(status);
}
