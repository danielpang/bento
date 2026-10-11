import { and, desc, eq, inArray } from "drizzle-orm";
import { agentRuns, featureMessages, features } from "@bento/db";
import type { AppContext } from "../context.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/**
 * Timers that wait for work.
 *
 * A five-minute cron that always asks Postgres is what kept Neon
 * awake. Each of those sweeps is now a per-row schedule, a Redis
 * presence check, or a daily cleanup:
 *
 * - A card entering `gated` gets `gate:<featureId>` every five
 *   minutes. Leaving removes it. The evaluate worker upserts the next
 *   fire so a pg-boss named schedule (one delayed job) keeps ticking.
 * - Parking a message because the team is out of compute raises a
 *   presence counter. The stranded-message sweep is scheduled only
 *   while that counter is above zero. A plan change can tick it
 *   directly via `armParkedComputeSweep`.
 * - Expired MCP grants and OAuth rows move to the daily job. They are
 *   row cleanup, not latency.
 * - A runner claim arms `runner-lease:<runId>` with debounce. Each
 *   heartbeat pushes the delay back. The job fires only when the
 *   machine goes silent.
 *
 * Redis (or the in-process map on pg-boss) can drift if a process
 * dies between a row change and a counter update. Boot recomputes
 * every schedule and signal from the rows, and the daily job does it
 * again so a counter stuck at zero is minutes of latency, not a
 * message that waits for the next deploy.
 */

export const GATE_CARD_CRON = "*/5 * * * *";
export const PARKED_COMPUTE_CRON = "*/5 * * * *";
export const WORK_TIMER_DAILY_CRON = "0 9 * * *";

export const PARKED_COMPUTE_PRESENCE_KEY = "parked-compute";
export const PARKED_COMPUTE_SWEEP_ID = "gate.parked";
export const WORK_TIMER_DAILY_ID = "gate.sweep";

export function gateSchedulerId(featureId: string): string {
  return `gate:${featureId}`;
}

export function runnerLeaseKey(runId: string): string {
  return `runner-lease:${runId}`;
}

export function runnerLeaseDelayMs(timeoutMin: number): number {
  return timeoutMin * 60_000;
}

/**
 * Puts this card's gate clock in the state its row implies.
 *
 * Idempotent. Entering gated upserts `gate:<id>`; leaving removes it.
 */
export async function syncGateSchedule(ctx: AppContext, featureId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ id: features.id, status: features.status })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!row || row.status !== "gated") {
    await ctx.jobs.unschedule(gateSchedulerId(featureId)).catch(() => {
      // Already gone is the state this wanted.
    });
    return;
  }
  await ctx.jobs.schedule(gateSchedulerId(featureId), "gate.evaluate", GATE_CARD_CRON, {
    featureId,
  });
}

/**
 * Boot and the daily safety pass: every gated card gets its scheduler.
 *
 * A leftover `gate:<id>` for a card that is no longer gated is not
 * listed here. The next fire evaluates, sees the row, and unschedules.
 */
export async function reconcileGateSchedules(ctx: AppContext): Promise<string[]> {
  const gated = await ctx.db.select({ id: features.id }).from(features).where(eq(features.status, "gated"));
  for (const row of gated) await syncGateSchedule(ctx, row.id);
  return gated.map((row) => row.id);
}

/**
 * Pushes this run's lease back by the claim timeout.
 *
 * debounceKey replaces a waiting delayed job, so a reporting runner
 * never lets the previous fire land. A silent one does.
 */
export async function refreshRunnerLease(ctx: AppContext, runId: string): Promise<void> {
  await ctx.jobs.send("runner.reap", { runId }, {
    debounceKey: runnerLeaseKey(runId),
    delayMs: runnerLeaseDelayMs(ctx.env.BENTO_RUNNER_CLAIM_TIMEOUT_MIN),
  });
}

/**
 * Boot: every claimed runner run gets a lease again. A flush or a
 * restart loses only the time already elapsed on the previous one.
 */
export async function reconcileRunnerLeases(ctx: AppContext): Promise<string[]> {
  const claimed = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.executor, "runner"),
        eq(agentRuns.type, "pipeline"),
        inArray(agentRuns.status, ["starting", "running"]),
      ),
    );
  for (const row of claimed) await refreshRunnerLease(ctx, row.id);
  return claimed.map((row) => row.id);
}

/**
 * Cards whose queued messages have no active run to deliver them.
 *
 * A card with no run yet waits for its first start, not this sweep.
 * An active run's own end delivers. Everything else is parked work
 * the allowance (or a crash) left behind.
 */
export async function countParkedComputeWork(ctx: Pick<AppContext, "db">): Promise<number> {
  const queued = await ctx.db
    .selectDistinct({ featureId: featureMessages.featureId })
    .from(featureMessages)
    .where(eq(featureMessages.status, "queued"));
  let count = 0;
  for (const row of queued) {
    const [lastRun] = await ctx.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.featureId, row.featureId))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    if (!lastRun) continue;
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(lastRun.status)) continue;
    count += 1;
  }
  return count;
}

async function ensureParkedComputeSweep(ctx: AppContext): Promise<void> {
  await ctx.jobs.schedule(PARKED_COMPUTE_SWEEP_ID, "gate.sweep", PARKED_COMPUTE_CRON, {
    kind: "parked",
  });
}

/**
 * Parking for compute: raise the counter and hold a sweep only while
 * it is above zero. The daily job recomputes if this increment is lost.
 */
export async function signalParkedCompute(ctx: AppContext): Promise<void> {
  const current = await ctx.jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY);
  await ctx.jobs.setPresence(PARKED_COMPUTE_PRESENCE_KEY, current + 1);
  await ensureParkedComputeSweep(ctx);
}

/**
 * Rebuild the parked-compute signal from the rows, and drop the sweep
 * when nothing is waiting.
 */
export async function syncParkedComputePresence(ctx: AppContext): Promise<number> {
  const count = await countParkedComputeWork(ctx);
  await ctx.jobs.setPresence(PARKED_COMPUTE_PRESENCE_KEY, count);
  if (count > 0) await ensureParkedComputeSweep(ctx);
  else {
    await ctx.jobs.unschedule(PARKED_COMPUTE_SWEEP_ID).catch(() => {
      // Already gone is the state this wanted.
    });
  }
  return count;
}

/**
 * Whether the parked-message sweep should touch Postgres.
 *
 * A zero here is the idle path: no query. A counter stuck at zero
 * while work exists is the daily job's problem.
 */
export async function parkedComputeSweepShouldRun(ctx: Pick<AppContext, "jobs">): Promise<boolean> {
  return (await ctx.jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY)) > 0;
}

/** A plan change or period reset can arm the sweep without waiting. */
export async function armParkedComputeSweep(ctx: AppContext): Promise<void> {
  await ensureParkedComputeSweep(ctx);
}

/**
 * Idle means no per-card clocks, no parked sweep, no runner leases.
 * The daily cleanup is the one schedule an empty deployment keeps.
 */
export function isIdleWorkTimerSchedule(id: string): boolean {
  return id !== WORK_TIMER_DAILY_ID;
}
