import type { AppContext } from "../context.js";
import type { JobCounts } from "../jobs/types.js";

export const RUN_QUEUE_SNAPSHOT_EVENT = "run queue snapshot";

export type ServerRunCounts = {
  queued: number;
  busy: number;
};

/**
 * Waiting plus delayed jobs are the depth to scale on. Active jobs
 * already occupy a worker. An empty queue is `null`: the telemetry
 * job must emit nothing, not a zero gauge that keeps a dashboard
 * writing on a quiet night.
 */
export function snapshotFromQueueCounts(counts: JobCounts): ServerRunCounts | null {
  const queued = counts.waiting + counts.delayed;
  const busy = counts.active;
  if (queued === 0 && busy === 0) return null;
  return { queued, busy };
}

/**
 * How many `run.execute` jobs are waiting for a worker, versus
 * already occupying one.
 *
 * Counted from the queue, not `agent_runs`. A row can sit queued
 * after its job has started (or finished), and `executeRun` no-ops
 * in that case. The adapter's `counts` is Redis on BullMQ and the
 * pg-boss size on local/Mac — neither opens the app tables.
 *
 * `queued` is the number to scale workers on. `busy` and `workers`
 * say whether this process is already saturated.
 *
 * `app` and `instance` name the reporting process on Fly, and are
 * omitted elsewhere. Every machine reports the same queue-wide
 * `queued`, so a dashboard must average or max these snapshots, never
 * sum them.
 */
export async function captureRunQueueDepth(
  ctx: Pick<AppContext, "jobs" | "analytics" | "env">,
): Promise<void> {
  if (!ctx.analytics) return;

  const snapshot = snapshotFromQueueCounts(await ctx.jobs.counts("run.execute"));
  if (!snapshot) return;

  ctx.analytics.capture({
    event: RUN_QUEUE_SNAPSHOT_EVENT,
    properties: {
      queued: snapshot.queued,
      busy: snapshot.busy,
      workers: ctx.env.BENTO_MAX_CONCURRENT_RUNS,
      ...(ctx.env.FLY_APP_NAME ? { app: ctx.env.FLY_APP_NAME } : {}),
      ...(ctx.env.FLY_MACHINE_ID ? { instance: ctx.env.FLY_MACHINE_ID } : {}),
    },
  });
}
