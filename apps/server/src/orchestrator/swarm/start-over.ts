import { and, eq, sql } from "drizzle-orm";
import { swarmTasks } from "@bento/db";
import { captureJobErrors } from "../../analytics.js";
import type { AppContext } from "../../context.js";
import { QUEUE_POLL_SECONDS } from "../queue.js";
import { discardSwarmTaskWork, SandboxReapDeferred } from "../reap-sandbox.js";
import { enqueueSwarmTick } from "./coordinator.js";

/**
 * Starting a task over, after the request that asked for it.
 *
 * A person's Retry task, or Bento's own once a task's sandbox has
 * failed past its restarts, marks the task `startingOver` and queues
 * this. The job takes the old machine down (and the branch from a host
 * checkout), and only then clears the mark, which is what lets the
 * coordinator put a new agent on the task, in a new machine cut from
 * the swarm's branch. Done inline in the request, a slow provider
 * timed the request out after the agent had already been stopped.
 *
 * The branch is not lost by this: every worker run pushed it to
 * GitHub when it ended.
 */
export const SWARM_START_OVER_QUEUE = "swarm.task-start-over";

/** How many times a machine that will not go is tried before the task is failed instead. */
export const MAX_START_OVER_ATTEMPTS = 5;

const startOverWorkers = new WeakSet<object>();

export async function ensureStartOverWorker(ctx: AppContext): Promise<void> {
  if (startOverWorkers.has(ctx.boss)) return;
  startOverWorkers.add(ctx.boss);
  try {
    await ctx.boss.work<{ taskId: string }>(
      SWARM_START_OVER_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: QUEUE_POLL_SECONDS },
      captureJobErrors(ctx.analytics, SWARM_START_OVER_QUEUE, async (jobs) => {
        for (const job of jobs) await performTaskStartOver(ctx, job.data.taskId);
      }),
    );
  } catch (err) {
    startOverWorkers.delete(ctx.boss);
    throw err;
  }
}

export async function enqueueTaskStartOver(ctx: AppContext, taskId: string): Promise<void> {
  await ensureStartOverWorker(ctx);
  await ctx.boss.send(
    SWARM_START_OVER_QUEUE,
    { taskId },
    { singletonKey: taskId, retryLimit: MAX_START_OVER_ATTEMPTS, retryDelay: 30, retryBackoff: true },
  );
}

/**
 * Every task of a swarm still marked as starting over gets its job.
 * Asked after each tick, so a job a restart lost is asked for again
 * rather than leaving the task waiting forever; the singleton key keeps
 * a job already waiting from being queued twice.
 */
export async function resumeStartOvers(ctx: AppContext, swarmId: string): Promise<void> {
  const waiting = await ctx.db
    .select({ id: swarmTasks.id })
    .from(swarmTasks)
    .where(and(eq(swarmTasks.swarmId, swarmId), sql`${swarmTasks.flags} ->> 'startingOver' = 'true'`));
  for (const task of waiting) await enqueueTaskStartOver(ctx, task.id);
}

type StartOverFlags = { startingOver?: boolean; startOverAttempts?: number };

export async function performTaskStartOver(ctx: AppContext, taskId: string): Promise<void> {
  const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)).limit(1);
  if (!task || !(task.flags as StartOverFlags).startingOver) return;
  try {
    await discardSwarmTaskWork(ctx, { swarmTaskId: task.id, branch: task.branchName });
  } catch (err) {
    // An agent still in the machine: ask again later, the reap's own way.
    if (err instanceof SandboxReapDeferred) throw err;
    const attempts = ((task.flags as StartOverFlags).startOverAttempts ?? 0) + 1;
    if (attempts < MAX_START_OVER_ATTEMPTS) {
      await setFlags(ctx, task.id, { startOverAttempts: attempts });
      throw err;
    }
    // The machine will not go. The task fails with a sentence a person
    // can act on, rather than saying "restarting" forever.
    await ctx.db
      .update(swarmTasks)
      .set({
        status: "failed",
        attention: "failed",
        updatedAt: new Date(),
        flags: sql`(coalesce(${swarmTasks.flags}, '{}'::jsonb) - 'startingOver' - 'startOverAttempts') || ${JSON.stringify({
          workerStopped: "its old sandbox could not be removed, so it was not started over. Retry the task to try again.",
        })}::jsonb`,
      })
      .where(eq(swarmTasks.id, task.id));
    await enqueueSwarmTick(ctx, task.swarmId);
    return;
  }
  await ctx.db
    .update(swarmTasks)
    .set({
      flags: sql`coalesce(${swarmTasks.flags}, '{}'::jsonb) - 'startingOver' - 'startOverAttempts'`,
      updatedAt: new Date(),
    })
    .where(eq(swarmTasks.id, task.id));
  await enqueueSwarmTick(ctx, task.swarmId);
}

async function setFlags(ctx: AppContext, taskId: string, flags: Record<string, unknown>): Promise<void> {
  await ctx.db
    .update(swarmTasks)
    .set({ flags: sql`coalesce(${swarmTasks.flags}, '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb` })
    .where(eq(swarmTasks.id, taskId));
}
