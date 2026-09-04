import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, type Db } from "@bento/db";
import type { Analytics } from "../analytics.js";
import type { Entitlements } from "../context.js";

type AgentRun = typeof agentRuns.$inferSelect;
/**
 * agent_runs carries both boards now. This door is the card's ("one
 * card, one agent"), so it takes a card's run and says so in the type:
 * the board is stated rather than inferred from which ids happen to be
 * filled in, and the card and stage it needs are required rather than
 * nullable columns every line below would have to re-check.
 */
type NewRun = typeof agentRuns.$inferInsert & {
  type: "pipeline";
  featureId: string;
  stageId: string;
};

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
 * The same condition, said to somebody deleting the card. CARD_BUSY
 * offers "wait for it to finish", which is advice about starting a
 * second run: waiting does not delete a card.
 */
export const CARD_BUSY_DELETE = "An agent is working this card. Stop it first, then delete.";

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
 *
 * The lock is also what a delete takes, so a start racing a delete
 * waits for it and then finds no row. "gone" rather than an insert that
 * dies on its foreign key: every caller has something better to say
 * about a card that is not there than a 500.
 */
export async function startRunIfIdle(
  db: Db,
  values: NewRun,
  entitlements?: Entitlements,
  analytics?: Analytics,
  /**
   * Runs the "agent run started" capture once the caller's surrounding
   * transaction has committed. The HTTP routes pass `db(c, ctx)`, which
   * in multi mode is the request's tenant transaction, so the
   * db.transaction below is only a savepoint there and finishing it
   * proves nothing: the request can still roll back, and an event
   * captured now would count a run that never existed. Those callers
   * pass their deferAfterCommit. Orchestrator callers run on the owner
   * pool, where the transaction below really commits, and omit this.
   */
  defer?: (task: () => void) => void,
): Promise<AgentRun | "busy" | "gone" | OutOfCompute> {
  const result = await db.transaction(async (tx) => {
    /**
     * The lock also answers whose organization this is. Callers do not
     * pass it: `organization_id` on a run is derived by an insert
     * trigger from the feature, so the row being locked here is the
     * only place it can be read from before the insert exists.
     */
    const locked = await tx.execute(
      sql`select organization_id from features where id = ${values.featureId} for update`,
    );
    if (locked.rows.length === 0) return "gone" as const;
    const organizationId =
      (locked.rows[0] as { organization_id: string | null } | undefined)?.organization_id ?? null;

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, values.featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    // Busy first: it is the more specific answer, and a card already
    // being worked is not a question about anybody's plan.
    if (active) return "busy" as const;

    if (entitlements?.canStartRun && organizationId) {
      const refusal = await entitlements.canStartRun(organizationId, values.featureId);
      if (refusal) return { outOfCompute: refusal.reason };
    }

    const [run] = await tx.insert(agentRuns).values(values).returning();
    if (!run) throw new Error("run insert returned no row");
    return run;
  });

  if (result !== "busy" && result !== "gone" && !("outOfCompute" in result)) {
    // The insert trigger derived organization_id from the feature, and
    // RETURNING reads the row after BEFORE triggers ran, so the row
    // carries the tenant without another query.
    const capture = () =>
      analytics?.capture({
        event: "agent run started",
        userId: result.startedBy ?? null,
        organizationId: result.organizationId,
        properties: {
          run_id: result.id,
          feature_id: result.featureId,
          stage_id: result.stageId,
          kind: result.kind,
          executor: result.executor,
          resumed: Boolean(values.cliSessionId),
        },
      });
    if (defer) defer(capture);
    else capture();
  }
  return result;
}
