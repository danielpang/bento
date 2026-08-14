import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, type Db } from "@bento/db";
import type { Entitlements } from "../context.js";

type AgentRun = typeof agentRuns.$inferSelect;
type NewRun = typeof agentRuns.$inferInsert;

/**
 * A run that was not started because the plan has nothing left.
 *
 * An object rather than another string sentinel, so the reason can
 * travel with it: what a team has run out of, and what they can do
 * about it, is the whole content of the answer.
 */
export interface OutOfCompute {
  outOfCompute: string;
}

/** A run in one of these states is still working (or about to). */
export const ACTIVE_RUN_STATUSES = ["queued", "starting", "running"] as const;

/** What every door tells the user when a card is already being worked. */
export const CARD_BUSY = "an agent is already working this card; wait for it to finish or cancel it first";

/**
 * Inserts a run only when the feature has no run queued or working.
 *
 * One card, one agent: a double click on Start, a drag during a run, or
 * two tabs racing each other would otherwise stack sandboxes on the same
 * branch. The feature row is locked first so concurrent starts
 * serialize; the loser sees the winner's run and gets "busy" instead of
 * a second run.
 *
 * It is also where the plan's compute allowance is checked, for the
 * same reason every door already comes through here: a check that
 * lives at the doors instead gets forgotten at the next one somebody
 * adds. A deployment without entitlements has no allowance and this
 * costs it one skipped branch.
 */
export async function startRunIfIdle(
  db: Db,
  values: NewRun,
  entitlements?: Entitlements,
): Promise<AgentRun | "busy" | OutOfCompute> {
  return db.transaction(async (tx) => {
    /**
     * The lock also answers whose organization this is. Callers do not
     * pass it: `organization_id` on a run is derived by an insert
     * trigger from the feature, so the row being locked here is the
     * only place it can be read from before the insert exists.
     */
    const locked = await tx.execute(
      sql`select organization_id from features where id = ${values.featureId} for update`,
    );
    const organizationId =
      (locked.rows[0] as { organization_id: string | null } | undefined)?.organization_id ?? null;

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, values.featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    // Busy first: it is the more specific answer, and a card already
    // being worked is not a question about anybody's plan.
    if (active) return "busy";

    if (entitlements?.canStartRun && organizationId) {
      const refusal = await entitlements.canStartRun(organizationId, values.featureId);
      if (refusal) return { outOfCompute: refusal.reason };
    }

    const [run] = await tx.insert(agentRuns).values(values).returning();
    if (!run) throw new Error("run insert returned no row");
    return run;
  });
}
