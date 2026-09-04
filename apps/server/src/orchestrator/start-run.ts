import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentRuns, swarmLandings, type Db } from "@bento/db";
import type { Analytics } from "../analytics.js";
import type { Entitlements } from "../context.js";

type AgentRun = typeof agentRuns.$inferSelect;
/**
 * agent_runs carries both boards now. A card's run says so in the type:
 * the board is stated rather than inferred from which ids happen to be
 * filled in, and the card and stage it needs are required rather than
 * nullable columns every line below would have to re-check.
 */
type PipelineNewRun = typeof agentRuns.$inferInsert & {
  type: "pipeline";
  featureId: string;
  stageId: string;
};

/** The roles a swarm run can hold. A stage role belongs to the other board. */
export type SwarmRunRole = "planner" | "subplanner" | "worker" | "resolver" | "judge";

/**
 * A swarm's run: a swarm, a role, and for everything below the planner
 * the task it acts on. Same shape rule as the card's, read off the
 * columns the check constraints already hold.
 */
type SwarmNewRun = typeof agentRuns.$inferInsert & {
  type: "swarm";
  swarmId: string;
  role: SwarmRunRole;
};

/**
 * One door, two boards. The discriminator is the row's own statement
 * about which board it belongs to, so a caller cannot reach the wrong
 * concurrency rule by filling in the wrong ids.
 */
export type NewRun = PipelineNewRun | SwarmNewRun;

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
  const result = await db.transaction(async (tx) =>
    values.type === "swarm" ? insertSwarmRun(tx, values, entitlements) : insertPipelineRun(tx, values, entitlements),
  );

  if (result !== "busy" && result !== "gone" && !("outOfCompute" in result)) {
    // The insert trigger derived organization_id from the parent row,
    // and RETURNING reads the row after BEFORE triggers ran, so the row
    // carries the tenant without another query.
    const capture = () =>
      analytics?.capture({
        event: "agent run started",
        userId: result.startedBy ?? null,
        organizationId: result.organizationId,
        properties: {
          run_id: result.id,
          type: result.type,
          role: result.role,
          feature_id: result.featureId,
          stage_id: result.stageId,
          swarm_id: result.swarmId,
          swarm_task_id: result.swarmTaskId,
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

/** The transaction handle drizzle hands the callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One card, one agent, decided under the feature row's lock. */
async function insertPipelineRun(
  tx: Tx,
  values: PipelineNewRun,
  entitlements?: Entitlements,
): Promise<AgentRun | "busy" | "gone" | OutOfCompute> {
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
}

/**
 * The same door for a swarm, decided under the swarm row's lock.
 *
 * A swarm is many agents on purpose, so "one card, one agent" is the
 * wrong rule here and each role gets its own. What does carry over is
 * where the answer is decided: one lock, taken before anything is
 * counted, so two starts racing each other serialize and the loser is
 * told the swarm is busy rather than adding a second planner or an
 * over-quota worker. The lock is also what a delete takes, so a start
 * racing a delete waits and then finds no row.
 */
async function insertSwarmRun(
  tx: Tx,
  values: SwarmNewRun,
  entitlements?: Entitlements,
): Promise<AgentRun | "busy" | "gone" | OutOfCompute> {
  // A caller bug, not a state: a worker or a sub planner without the
  // leaf it works is a run nothing could ever attribute or finish.
  if ((values.role === "worker" || values.role === "subplanner") && !values.swarmTaskId) {
    throw new Error(`a swarm ${values.role} run must name its task`);
  }

  const locked = await tx.execute(
    sql`select organization_id, max_workers from swarms where id = ${values.swarmId} for update`,
  );
  if (locked.rows.length === 0) return "gone" as const;
  const swarm = locked.rows[0] as { organization_id: string | null; max_workers: number };
  const organizationId = swarm.organization_id ?? null;

  /** Whether any run matching this is queued, starting, or running. */
  const anyActive = async (where: ReturnType<typeof and>): Promise<boolean> => {
    const [row] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(inArray(agentRuns.status, ACTIVE_RUN_STATUSES), eq(agentRuns.swarmId, values.swarmId), where))
      .limit(1);
    return Boolean(row);
  };

  if (values.role === "planner") {
    // One planner per swarm. The planner owns the tree, and two of
    // them editing it would each be working from a plan the other is
    // changing underneath.
    if (await anyActive(eq(agentRuns.role, "planner"))) return "busy" as const;
  } else if (values.role === "subplanner") {
    // Per group instead: sub planners decompose different branches of
    // the tree and have no reason to wait on each other.
    const busy = await anyActive(
      and(eq(agentRuns.role, "subplanner"), eq(agentRuns.swarmTaskId, values.swarmTaskId!)),
    );
    if (busy) return "busy" as const;
  } else if (values.role === "worker") {
    // One agent per leaf, for the pipeline's reason: two on one branch
    // is two agents editing each other's work.
    if (await anyActive(eq(agentRuns.swarmTaskId, values.swarmTaskId!))) return "busy" as const;
    // And no more at once than the swarm was allowed. Counted here,
    // under the lock, because the ceiling is the whole reason a person
    // sets it: a check outside the lock lets two spawns both see room.
    const [counted] = await tx
      .select({ workers: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
          eq(agentRuns.swarmId, values.swarmId),
          eq(agentRuns.role, "worker"),
        ),
      );
    if ((counted?.workers ?? 0) >= swarm.max_workers) return "busy" as const;
  } else if (values.role === "resolver") {
    // A resolver exists to answer a conflict, so with none waiting
    // there is nothing for it to do. One at a time as well: the merge
    // queue lands one branch at a time by construction.
    if (await anyActive(eq(agentRuns.role, "resolver"))) return "busy" as const;
    const [conflicted] = await tx
      .select({ id: swarmLandings.id })
      .from(swarmLandings)
      .where(and(eq(swarmLandings.swarmId, values.swarmId), eq(swarmLandings.status, "conflicted")))
      .limit(1);
    if (!conflicted) return "busy" as const;
  } else {
    // A judge, scoped the way its subject is: a leaf's judge per leaf,
    // a swarm's judge per swarm.
    const busy = await anyActive(
      and(
        eq(agentRuns.role, "judge"),
        values.swarmTaskId ? eq(agentRuns.swarmTaskId, values.swarmTaskId) : isNull(agentRuns.swarmTaskId),
      ),
    );
    if (busy) return "busy" as const;
  }

  // The organization comes off the locked row, never off the caller:
  // the same reason as the card's path, and it is what makes the plan
  // question about the team whose swarm this is.
  if (entitlements?.canStartRun && organizationId) {
    const refusal = await entitlements.canStartRun(organizationId);
    if (refusal) return { outOfCompute: refusal.reason };
  }

  const [run] = await tx.insert(agentRuns).values(values).returning();
  if (!run) throw new Error("run insert returned no row");
  return run;
}
