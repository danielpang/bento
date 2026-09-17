import { readdir } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { agentRuns, features, repositories, sandboxes } from "@bento/db";
import type { AppContext } from "../context.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/** The queue a finished card's sandbox goes through on its way out. */
export const REAP_SANDBOX_QUEUE = "sandbox.reap";

/** Directory names under worktrees/ are feature ids by construction. */
const FEATURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Destroys the sandbox belonging to a card that is over, and in local
 * mode the host workspace that container was bind-mounting.
 *
 * A sandbox is a machine somebody is paying for by the gigabyte month,
 * for as long as it exists, whether or not it ever wakes again. Fly
 * bills storage on every sprite that has not been destroyed, so a card
 * that finished in March is still on the April invoice, and still on
 * next year's, and goes on being charged after the customer has left.
 * The workspace is the local-mode equivalent: worktrees plus leftover
 * node_modules sitting under BENTO_DATA_DIR until something deletes
 * them. Artifacts are not here; they live in Postgres and the artifact
 * store, and nothing in this function touches either.
 *
 * Deliberately not gentle about verification. `destroy` is best effort
 * on every driver, so believing it would let one unreachable API call
 * mark a machine gone while it goes on billing, which is the exact
 * failure this exists to prevent. The row is only marked destroyed
 * once the driver has been asked again and said the machine is gone.
 */
export async function reapSandbox(ctx: AppContext, featureId: string): Promise<void> {
  /**
   * A card is not supposed to finish with an agent still working it,
   * but the gate evaluator and a manual start can race, and killing a
   * sandbox out from under a running agent would leave the branch in a
   * state nobody chose. Throwing rather than skipping, so the job
   * retries: skipping would drop the only reference to this machine
   * and leak it for good. Checked before looking at sandbox rows: a
   * card whose provisioning failed has worktrees but may have no
   * machine, and those still must not vanish under a live agent.
   */
  const [working] = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  if (working) throw new Error(`a run is still working feature ${featureId}; not reaping its sandbox yet`);

  const rows = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")));

  /**
   * Every row, not the first one.
   *
   * A card holds one machine at a time, but not necessarily the same
   * one for its whole life: the Docker driver rebuilds a container
   * when the mounts it was built for stop being the truth, and the new
   * one has a new id. Reaping a single row left the earlier machines
   * with nothing pointing at them.
   */
  for (const row of rows) {
    const handle = {
      externalId: row.externalId,
      provider: row.provider,
      workdir: row.workdir,
    };
    await ctx.driver.destroy(handle);

    // Drivers that can answer are asked. One that cannot is taken at
    // its word, which is right for the local ones: a container on
    // somebody's laptop bills nobody, so there is no leak to be
    // careful about.
    if (ctx.driver.exists && (await ctx.driver.exists(handle))) {
      throw new Error(`sandbox ${row.externalId} is still there after being destroyed; will retry`);
    }

    await ctx.db.update(sandboxes).set({ status: "destroyed" }).where(eq(sandboxes.id, row.id));
    console.log(`reaped sandbox ${row.externalId} for finished feature ${featureId}`);
  }

  await removeFeatureWorkspace(ctx, featureId);
}

/**
 * Drops the card's host workspace. Sprite deployments never create
 * one, so the removal is a no-op there; a deployment that switched
 * drivers mid-card still gets cleaned.
 */
async function removeFeatureWorkspace(ctx: AppContext, featureId: string): Promise<void> {
  const [feature] = await ctx.db
    .select({ projectId: features.projectId })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!feature) {
    await ctx.worktrees.removeWorkspace([], featureId);
    return;
  }
  const repos = await ctx.db
    .select({ name: repositories.name, localPath: repositories.localPath })
    .from(repositories)
    .where(eq(repositories.projectId, feature.projectId));
  await ctx.worktrees.removeWorkspace(repos, featureId);
}

/**
 * Sweeps up sandboxes belonging to cards that finished before this
 * existed, and any the queue lost, plus leftover host workspaces the
 * machine pass cannot see.
 *
 * A job that failed every retry leaves a machine nobody is looking for,
 * and the first run of this on an existing deployment is the only thing
 * that will ever reclaim the cards finished up to now. Workspaces of
 * cards whose machines were already marked destroyed (or never
 * provisioned) are the same story: only this pass will ever take them.
 */
export async function reapFinishedSandboxes(ctx: AppContext): Promise<void> {
  const stale = await ctx.db
    .select({ featureId: sandboxes.featureId })
    .from(sandboxes)
    .innerJoin(features, eq(features.id, sandboxes.featureId))
    .where(and(ne(sandboxes.status, "destroyed"), inArray(features.status, ["done", "cancelled"])));

  // Distinct: reapSandbox takes every row a card holds, so a card with
  // more than one would otherwise be visited once per row and do
  // nothing on all but the first.
  for (const featureId of new Set(stale.map((row) => row.featureId))) {
    if (!featureId) continue;
    try {
      await reapSandbox(ctx, featureId);
    } catch (err) {
      // One machine that will not go must not stop the rest going.
      console.warn(`could not reap the sandbox for feature ${featureId}:`, err);
      ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "sandbox_reap" });
    }
  }

  const worktreesRoot = path.join(ctx.env.BENTO_DATA_DIR, "worktrees");
  let entries;
  try {
    entries = await readdir(worktreesRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !FEATURE_ID.test(entry.name)) continue;
    const featureId = entry.name;
    try {
      const [feature] = await ctx.db
        .select({ status: features.status })
        .from(features)
        .where(eq(features.id, featureId))
        .limit(1);
      if (!feature) {
        await ctx.worktrees.removeWorkspace([], featureId);
        continue;
      }
      if (feature.status !== "done" && feature.status !== "cancelled") continue;
      await reapSandbox(ctx, featureId);
    } catch (err) {
      console.warn(`could not reap the workspace for feature ${featureId}:`, err);
      ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "sandbox_reap" });
    }
  }
}
