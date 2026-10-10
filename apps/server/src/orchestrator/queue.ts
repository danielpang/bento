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
 *
 * BullMQ (multi mode) is push-based. These poll constants stay on the
 * pg-boss path only: local, desktop, TUI, and the Mac app. enqueueRun
 * does not wake a BullMQ queue.
 */

/**
 * Seconds an idle worker sleeps between polls, for every queue that
 * does not set its own. The queues on this cadence are fed by cron
 * every few minutes or by a bulk sync, so ten seconds of pickup lag is
 * invisible next to the interval that produced the job.
 */
export const QUEUE_POLL_SECONDS = 10;

/**
 * Seconds an idle worker sleeps when a person is waiting on the job:
 * a card moving after its run, a Slack mention or Approve, a Linear
 * webhook, filing or mirroring an issue. One worker at two seconds is
 * cheap. Thirty-two run workers at two seconds were not, which is why
 * those poll slowly and enqueueRun wakes them instead.
 */
export const INTERACTIVE_POLL_SECONDS = 2;

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
 * Queues a run for the `run.execute` workers.
 *
 * On pg-boss this also wakes this process's own workers, so the run
 * starts now rather than on their next poll. All of them are notified
 * rather than one: a busy worker only acts on the nudge once its run
 * ends, and an idle one fetches once and goes back to sleep.
 *
 * On BullMQ the send is enough: one Worker with `BENTO_MAX_CONCURRENT_RUNS`
 * is handed the job as soon as it is added. A context without workers
 * (a viewer's machine, a test that never registered jobs) just queues.
 */
export async function enqueueRun(ctx: Pick<AppContext, "jobs">, runId: string): Promise<void> {
  await ctx.jobs.send("run.execute", { runId });
  if (ctx.jobs.kind === "bullmq") return;
  ctx.jobs.wake("run.execute");
}

/**
 * Queues a gate evaluation for one card.
 *
 * Every door uses this rather than a bare send: two evaluations of
 * the same card are the same work, and a send that lands while an
 * evaluation is already running must still produce one more look.
 * The coalesce key is the card. Routes that write the row the
 * evaluation will read call this after commit.
 */
export async function enqueueGateEvaluate(
  ctx: Pick<AppContext, "jobs">,
  featureId: string,
): Promise<void> {
  await ctx.jobs.send("gate.evaluate", { featureId }, { coalesceKey: featureId });
}
