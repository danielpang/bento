import { and, eq, inArray, ne } from "drizzle-orm";
import { agentRuns, features, sandboxes } from "@bento/db";
import type { AppContext } from "../context.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/** The queue a finished card's sandbox goes through on its way out. */
export const REAP_SANDBOX_QUEUE = "sandbox.reap";

/**
 * Asks for a card's sandbox to be destroyed.
 *
 * Queued rather than done inline: destroying a sprite is a network
 * call to another provider, and a card should not fail to finish
 * because Fly was slow. A job retries; a click does not.
 */
export async function queueSandboxReap(ctx: AppContext, featureId: string): Promise<void> {
  await ctx.boss.send(REAP_SANDBOX_QUEUE, { featureId });
}

/**
 * Destroys the sandbox belonging to a card that is over.
 *
 * A sandbox is a machine somebody is paying for by the gigabyte month,
 * for as long as it exists, whether or not it ever wakes again. Fly
 * bills storage on every sprite that has not been destroyed, so a card
 * that finished in March is still on the April invoice, and still on
 * next year's, and goes on being charged after the customer has left.
 * Nothing else in this server reclaims one.
 *
 * Deliberately not gentle about verification. `destroy` is best effort
 * on every driver, so believing it would let one unreachable API call
 * mark a machine gone while it goes on billing, which is the exact
 * failure this exists to prevent. The row is only marked destroyed
 * once the driver has been asked again and said the machine is gone.
 */
export async function reapSandbox(ctx: AppContext, featureId: string): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")))
    .limit(1);
  if (!row) return;

  /**
   * A card is not supposed to finish with an agent still working it,
   * but the gate evaluator and a manual start can race, and killing a
   * sandbox out from under a running agent would leave the branch in a
   * state nobody chose. Throwing rather than skipping, so the job
   * retries: skipping would drop the only reference to this machine
   * and leak it for good.
   */
  const [working] = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  if (working) throw new Error(`a run is still working feature ${featureId}; not reaping its sandbox yet`);

  const handle = {
    externalId: row.externalId,
    provider: row.provider,
    workdir: row.workdir,
  };
  await ctx.driver.destroy(handle);

  // Drivers that can answer are asked. One that cannot is taken at its
  // word, which is right for the local ones: a container on somebody's
  // laptop bills nobody, so there is no leak to be careful about.
  if (ctx.driver.exists && (await ctx.driver.exists(handle))) {
    throw new Error(`sandbox ${row.externalId} is still there after being destroyed; will retry`);
  }

  await ctx.db.update(sandboxes).set({ status: "destroyed" }).where(eq(sandboxes.id, row.id));
  console.log(`reaped sandbox ${row.externalId} for finished feature ${featureId}`);
}

/**
 * Sweeps up sandboxes belonging to cards that finished before this
 * existed, and any the queue lost.
 *
 * A job that failed every retry leaves a machine nobody is looking for,
 * and the first run of this on an existing deployment is the only thing
 * that will ever reclaim the cards finished up to now.
 */
export async function reapFinishedSandboxes(ctx: AppContext): Promise<void> {
  const stale = await ctx.db
    .select({ featureId: sandboxes.featureId })
    .from(sandboxes)
    .innerJoin(features, eq(features.id, sandboxes.featureId))
    .where(and(ne(sandboxes.status, "destroyed"), inArray(features.status, ["done", "cancelled"])));

  for (const { featureId } of stale) {
    if (!featureId) continue;
    try {
      await reapSandbox(ctx, featureId);
    } catch (err) {
      // One machine that will not go must not stop the rest going.
      console.warn(`could not reap the sandbox for feature ${featureId}:`, err);
    }
  }
}
