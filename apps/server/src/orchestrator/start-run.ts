import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, type Db } from "@bento/db";

type AgentRun = typeof agentRuns.$inferSelect;
type NewRun = typeof agentRuns.$inferInsert;

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
 */
export async function startRunIfIdle(db: Db, values: NewRun): Promise<AgentRun | "busy"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from features where id = ${values.featureId} for update`);
    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, values.featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (active) return "busy";
    const [run] = await tx.insert(agentRuns).values(values).returning();
    if (!run) throw new Error("run insert returned no row");
    return run;
  });
}
