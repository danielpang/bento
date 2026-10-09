import { nodeLanding } from "./layout.js";
import type { Swarm, SwarmDetail, SwarmTask } from "./types.js";

/**
 * Why something on a swarm is not moving, in words, when the console
 * can tell from what it already holds.
 *
 * Each answer mirrors a rule the coordinator applies, so a sentence
 * here is the reason the server is acting on and not a guess: a leaf
 * starts only once every depends_on prerequisite above it is done
 * (`leafAncestorsDone`), only while the swarm spawns at all, and only
 * when it has an agent to run as.
 */

/** Whether the swarm's branch failed its checks after this leaf landed, which sent it back. */
export function checksFailedAfterLanding(task: Pick<SwarmTask, "nodeType" | "status" | "flags">): boolean {
  const rejection = (task.flags as { rejection?: unknown }).rejection;
  return task.nodeType === "leaf" && task.status === "assigned" &&
    typeof rejection === "string" && rejection.includes("failed its checks");
}

/**
 * Why an assigned leaf is not started, or null when nothing the console
 * can see is holding it.
 *
 * The first prerequisite that is not done, walking up the way the
 * coordinator does; then the swarm not spawning; then no agent to run
 * it as. A leaf with nothing in the way is waiting for a free worker
 * slot or for the next pass, which the drawer says on its own.
 */
export function leafStartBlocker(
  task: SwarmTask,
  tasks: readonly SwarmTask[],
  swarm?: Pick<Swarm, "status" | "settings"> | null,
): string | null {
  if (task.nodeType !== "leaf" || task.status !== "assigned") return null;
  const byId = new Map(tasks.map((row) => [row.id, row]));
  const seen = new Set<string>([task.id]);
  let current: SwarmTask = task;
  while (current.parentId) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    if ((current.parentRelation ?? "contains") === "depends_on" && parent.status !== "done") {
      return `Waiting for "${parent.title}" to finish first. It is ${statusWord(parent)}.`;
    }
    current = parent;
  }
  if (swarm) {
    if (swarm.status === "paused") return "The swarm is paused. Resume it to start this task.";
    if (swarm.status === "planning") return "The plan has not been approved yet. Approve it to start this task.";
    if (swarm.status === "budget_exhausted") return "The swarm reached its budget. Raise it to start this task.";
    if (swarm.status === "timed_out") return "The swarm reached its time limit. Raise it to start this task.";
    if (!task.agentProfileId && !swarm.settings.workerProfileId) {
      return "This swarm has no worker agent. Choose one in Settings, or pick an agent for this task.";
    }
  }
  return null;
}

/** A status in the words the drawer would show for that node. */
function statusWord(task: Pick<SwarmTask, "status" | "nodeType">): string {
  if (task.status === "assigned" || task.status === "open") return "not started";
  if (task.status === "working") return "in progress";
  if (task.status === "landed") return "waiting to land";
  return task.status;
}

/**
 * The header's sentence for a running swarm with nothing running.
 *
 * Null when something is running or landing, when the console cannot
 * tell (a fixture that sent no run count), or for any other status.
 * Otherwise what it is waiting on, the most actionable first: reports
 * the planner has not reviewed, failed tasks somebody can retry, tasks
 * held by a prerequisite, and no worker agent at all.
 */
export function idleWords(detail: Pick<SwarmDetail, "swarm" | "tasks" | "landings" | "activeRunCount">): string | null {
  if (detail.swarm.status !== "running") return null;
  if (detail.activeRunCount === undefined || detail.activeRunCount > 0) return null;
  if (detail.landings.some((landing) => landing.status === "queued" || landing.status === "landing" || landing.status === "conflicted")) {
    return null;
  }
  const leaves = detail.tasks.filter((task) => task.nodeType === "leaf");
  const reviews = leaves.filter((task) => nodeLanding(task) === "review").length;
  const failed = leaves.filter((task) => task.status === "failed").length;
  const assigned = leaves.filter((task) => task.status === "assigned" && !(task.flags as { startingOver?: unknown }).startingOver);
  const held = assigned.filter((task) => leafStartBlocker(task, detail.tasks) !== null).length;
  const noWorker = assigned.length > held && !detail.swarm.settings.workerProfileId &&
    assigned.some((task) => !task.agentProfileId && leafStartBlocker(task, detail.tasks) === null);
  const reasons = [
    reviews === 1 ? "1 report is waiting for the planner to review it"
      : reviews > 1 ? `${reviews} reports are waiting for the planner to review them` : null,
    failed === 1 ? "1 failed task can be retried from its drawer"
      : failed > 1 ? `${failed} failed tasks can be retried from their drawers` : null,
    held === 1 ? "1 task is waiting for a task it depends on"
      : held > 1 ? `${held} tasks are waiting for tasks they depend on` : null,
    noWorker ? "no worker agent is set, so ready tasks cannot start (choose one in Settings)" : null,
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length === 0) return "No agent is running and nothing is waiting to land. The swarm starts the next ready task on its next pass.";
  return `No agent is running right now: ${reasons.join("; ")}.`;
}
