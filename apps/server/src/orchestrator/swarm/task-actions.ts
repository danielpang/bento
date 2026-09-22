import { and, eq, inArray, sql } from "drizzle-orm";
import { swarmTaskEvents, swarmTasks, type Db } from "@bento/db";

/**
 * What can be done to one node, written once.
 *
 * A swarm's tree is edited from two places that must agree: the planner
 * does it through its tools, and a person does it through the drawer.
 * Cancelling a node has to take its subtree with it whoever asked, and
 * splitting a leaf has to turn it into a plan node whoever asked, and
 * the moment those two rules live in two files they start to differ.
 * They did: the tools grew the subtree rule and the routes would have
 * been written next to them without it.
 *
 * So the rules live here and both callers use them. What is not here is
 * anything that reaches outside the rows: stopping the agent that is on
 * a node is the route's, because the planner's own tools deliberately
 * let a worker finish its turn, and because killing a run needs the
 * executor rather than a table.
 */

/** Anything that can write these tables: the pool, or a transaction on it. */
export type TaskWriter = Pick<Db, "select" | "update" | "insert">;

type Task = typeof swarmTasks.$inferSelect;

/** Who asked, which the event log records and nothing else reads. */
export interface Asker {
  /** The run that asked, when an agent did. */
  runId?: string | null;
  /** The person who asked, when a person did. */
  actorUserId?: string | null;
}

function askedBy(asker: Asker): { runId?: string; actorUserId?: string } {
  return {
    ...(asker.runId ? { runId: asker.runId } : {}),
    ...(asker.actorUserId ? { actorUserId: asker.actorUserId } : {}),
  };
}

/**
 * Cancels a node and everything under it.
 *
 * The subtree goes because a plan node nobody needs has no children
 * anybody needs, and because leaving them open would keep the rollup
 * above reporting work that is never going to happen.
 *
 * Returns the ids it actually cancelled, which is what makes it safe to
 * call twice: a node that was already cancelled is not cancelled again
 * and produces no second event.
 */
export async function cancelTaskTree(
  tx: TaskWriter,
  input: { task: Task; reason?: string | null; now?: Date } & Asker,
): Promise<string[]> {
  const now = input.now ?? new Date();
  const ids = [input.task.id, ...(await descendantIds(tx, input.task.id))];
  const cancelled = await tx
    .update(swarmTasks)
    .set({ status: "cancelled", attention: null, endedAt: now, updatedAt: now })
    .where(and(inArray(swarmTasks.id, ids), sql`${swarmTasks.status} <> 'cancelled'`))
    .returning({ id: swarmTasks.id });
  for (const row of cancelled) {
    await tx.insert(swarmTaskEvents).values({
      taskId: row.id,
      kind: "status_changed",
      toStatus: "cancelled",
      ...askedBy(input),
      ...(input.reason ? { detail: { reason: input.reason } } : {}),
    });
  }
  return cancelled.map((row) => row.id);
}

/** Every node under this one. Bounded by the tree, walked one level at a time. */
export async function descendantIds(tx: TaskWriter, taskId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [taskId];
  for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
    const rows = await tx.select({ id: swarmTasks.id }).from(swarmTasks).where(inArray(swarmTasks.parentId, frontier));
    frontier = rows.map((row) => row.id);
    found.push(...frontier);
  }
  return found;
}

/** Why a split was refused, in words the asker can act on. */
export type SplitRefusal = { refused: string };

export interface SplitChild {
  title: string;
  description?: string | undefined;
  weight?: number | undefined;
}

/**
 * Turns a leaf into a plan node with the children it should have been.
 *
 * The leaf's own assignment goes with it: a plan node is never worked
 * directly, so whatever this leaf was waiting for, its children are
 * what waits now.
 *
 * Refused rather than forced in the three cases where splitting would
 * lose something: a node that is already a plan node has children
 * already, a node an agent is working would have its work orphaned, and
 * a node that is done would have its finished work quietly reopened.
 */
export async function splitLeaf(
  tx: TaskWriter,
  input: { task: Task; children: SplitChild[]; now?: Date } & Asker,
): Promise<string[] | SplitRefusal> {
  const { task } = input;
  const now = input.now ?? new Date();
  if (task.nodeType !== "leaf") {
    return { refused: `Task ${task.id} is already a plan node. Add to it instead of splitting it.` };
  }
  if (task.status === "working" || task.status === "landed") {
    return { refused: `An agent is working ${task.id} right now. Cancel it first, or wait for its report.` };
  }
  if (task.status === "done") {
    return { refused: `Task ${task.id} is already done, so splitting it would lose its work.` };
  }
  if (input.children.length === 0) {
    return { refused: "A split needs at least one task to split into." };
  }

  await tx
    .update(swarmTasks)
    .set({ nodeType: "plan", status: "open", attention: null, assignedRunId: null, updatedAt: now })
    .where(eq(swarmTasks.id, task.id));

  const created: string[] = [];
  let position = 0;
  for (const child of input.children) {
    const [row] = await tx
      .insert(swarmTasks)
      .values({
        swarmId: task.swarmId,
        parentId: task.id,
        position: position++,
        nodeType: "leaf",
        title: child.title,
        description: child.description ?? "",
        weight: child.weight ?? 1,
      })
      .returning({ id: swarmTasks.id });
    if (row) created.push(row.id);
  }
  for (const id of created) {
    await tx.insert(swarmTaskEvents).values({ taskId: id, kind: "created", toStatus: "open", ...askedBy(input) });
  }
  await tx.insert(swarmTaskEvents).values({
    taskId: task.id,
    kind: "note",
    fromStatus: task.status,
    toStatus: "open",
    ...askedBy(input),
    detail: { split: created.length },
  });
  return created;
}

/**
 * Puts a leaf back in the queue to be worked again.
 *
 * The report goes, because the report was about the attempt that is
 * being discarded and leaving it would have the planner accepting work
 * nobody did this time. The attention goes for the same reason. What
 * stays is everything that says what the leaf is: its title, its
 * description as somebody may just have edited it, and the agent it was
 * reassigned to.
 *
 * The count of attempts stays on the row, because "this is the third
 * time" is the thing a person most wants to know before pressing it a
 * fourth.
 */
export async function retryLeaf(
  tx: TaskWriter,
  input: { task: Task; now?: Date } & Asker,
): Promise<Task | SplitRefusal> {
  const { task } = input;
  const now = input.now ?? new Date();
  if (task.nodeType !== "leaf") {
    return { refused: "A plan node is worked through its own tasks. Retry one of those." };
  }
  if (task.status === "cancelled") {
    return { refused: "This task was cancelled. The planner can hand the work out again." };
  }
  const retries = Number((task.flags as { retries?: unknown }).retries ?? 0);
  const [updated] = await tx
    .update(swarmTasks)
    .set({
      status: "assigned",
      attention: null,
      report: null,
      assignedRunId: null,
      startedAt: null,
      endedAt: null,
      flags: {
        ...task.flags,
        retries: Number.isFinite(retries) ? retries + 1 : 1,
        /*
         * And the latch that decides whether the planner hears about
         * this leaf again is cleared, for the reason planner-news
         * states: the leaf's news is new, so whatever the planner was
         * told before is not this.
         */
        plannerToldAt: undefined,
      },
      updatedAt: now,
    })
    .where(eq(swarmTasks.id, task.id))
    .returning();
  await tx.insert(swarmTaskEvents).values({
    taskId: task.id,
    kind: "status_changed",
    fromStatus: task.status,
    toStatus: "assigned",
    ...askedBy(input),
    detail: { retry: Number.isFinite(retries) ? retries + 1 : 1 },
  });
  return updated ?? task;
}

/**
 * Puts a different agent on one leaf.
 *
 * On the node rather than on the template, which is the whole point:
 * the ordinary answer to a leaf a cheap worker could not finish is a
 * stronger agent on that leaf, not a stronger agent on every leaf that
 * has not started yet. Null puts it back on the template's own worker.
 *
 * Reassigning does not start anything. It is almost always followed by
 * a retry, and keeping the two apart means a person can reassign a leaf
 * that is waiting its turn without also pushing it to the front.
 */
export async function reassignLeaf(
  tx: TaskWriter,
  input: { task: Task; agentProfileId: string | null; now?: Date } & Asker,
): Promise<Task | SplitRefusal> {
  const { task } = input;
  const now = input.now ?? new Date();
  if (task.nodeType !== "leaf") {
    return { refused: "A plan node has no agent of its own. Reassign one of its tasks." };
  }
  const [updated] = await tx
    .update(swarmTasks)
    .set({ agentProfileId: input.agentProfileId, updatedAt: now })
    .where(eq(swarmTasks.id, task.id))
    .returning();
  await tx.insert(swarmTaskEvents).values({
    taskId: task.id,
    kind: "note",
    ...askedBy(input),
    detail: { reassigned: input.agentProfileId },
  });
  return updated ?? task;
}
