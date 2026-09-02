import type { AppContext } from "../context.js";

/**
 * How pg-boss workers pace themselves, and the one door for queuing a
 * run.
 *
 * pg-boss has no push: every worker sleeps, asks Postgres for a job,
 * and sleeps again. At its default of two seconds, this process's
 * workers (one per concurrent run slot plus one per other queue) were
 * the bulk of the traffic on an otherwise idle database, around
 * seventeen transactions a second around the clock. On Neon that is
 * what held the compute above its smallest size and kept it from ever
 * scaling to zero, which was most of the bill.
 */

/**
 * Seconds an idle worker sleeps between polls, for every queue that
 * does not set its own. The queues on this cadence are fed by cron
 * every few minutes or by webhooks, so ten seconds of pickup lag is
 * invisible next to the interval that produced the job.
 */
export const QUEUE_POLL_SECONDS = 10;

/**
 * Seconds an idle `run.execute` worker sleeps. Deliberately long:
 * there is one such worker per slot (32 on hosted Fly), and together
 * they were most of the polling. A run queued by this process does
 * not wait for it, because enqueueRun wakes the workers. The poll is
 * the path for a run queued on another machine, and the safety net
 * for anything a wake missed.
 */
export const RUN_WORKER_POLL_SECONDS = 30;

/**
 * Queues a run for the `run.execute` workers and wakes this process's
 * own, so the run starts now rather than on their next poll.
 *
 * All of them are notified rather than one: a busy worker only acts
 * on the nudge once its run ends, and an idle one fetches once and
 * goes back to sleep, so the cost of waking every slot is a handful of
 * empty fetches at the moment a run is queued, which is when the
 * database is about to be busy anyway. A context without workers (a
 * viewer's machine, a test that never registered jobs) just queues.
 */
export async function enqueueRun(ctx: Pick<AppContext, "boss" | "runWorkers">, runId: string): Promise<void> {
  await ctx.boss.send("run.execute", { runId });
  for (const id of ctx.runWorkers ?? []) ctx.boss.notifyWorker(id);
}
