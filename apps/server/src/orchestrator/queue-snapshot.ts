import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns } from "@bento/db";
import type { AppContext } from "../context.js";

export const RUN_QUEUE_SNAPSHOT_EVENT = "run queue snapshot";

export type ServerRunCounts = {
  queued: number;
  busy: number;
};

const BUSY_STATUSES = ["starting", "running"] as const;

export function tallyServerRunCounts(
  rows: Array<{ status: string; n: number | string }>,
): ServerRunCounts {
  let queued = 0;
  let busy = 0;
  for (const row of rows) {
    const n = Number(row.n);
    if (!Number.isFinite(n)) continue;
    if (row.status === "queued") queued += n;
    else if ((BUSY_STATUSES as readonly string[]).includes(row.status)) busy += n;
  }
  return { queued, busy };
}

/**
 * How many server-executed runs are waiting for a worker, versus
 * already occupying one.
 *
 * Counted from `agent_runs`, not pg-boss: a job can sit in the queue
 * after the run has already started (or finished), and `executeRun`
 * no-ops in that case. Runner-queued rows wait on a runner machine,
 * not this process's `run.execute` workers, so they are excluded.
 *
 * `queued` is the number to scale workers on. `busy` and `workers`
 * say whether this process is already saturated.
 */
export async function captureRunQueueDepth(
  ctx: Pick<AppContext, "db" | "analytics" | "env">,
): Promise<void> {
  if (!ctx.analytics) return;

  const rows = await ctx.db
    .select({
      status: agentRuns.status,
      n: sql<number>`count(*)::int`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.executor, "server"),
        inArray(agentRuns.status, ["queued", "starting", "running"]),
      ),
    )
    .groupBy(agentRuns.status);

  const { queued, busy } = tallyServerRunCounts(rows);
  ctx.analytics.capture({
    event: RUN_QUEUE_SNAPSHOT_EVENT,
    properties: {
      queued,
      busy,
      workers: ctx.env.BENTO_MAX_CONCURRENT_RUNS,
    },
  });
}
