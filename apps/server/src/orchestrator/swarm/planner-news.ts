import { eq, sql } from "drizzle-orm";
import { agentRuns, swarmTaskEvents, swarmTasks, type Db } from "@bento/db";

/**
 * The one door a leaf goes through on its way to the planner, and the
 * filter that finds it again.
 *
 * A leaf that failed is news, and the planner is the only actor that
 * can do anything about it: split it, send it back, or give it up. The
 * wake that carries that news is folded once per leaf, and
 * `plannerToldAt` in the leaf's flags is the latch that makes it once:
 * set when the wake goes out, and required empty by the query that
 * builds the next one.
 *
 * Which means a write that fails a leaf without clearing the latch
 * hides that leaf from every future wake, for good. That is not a
 * hypothetical: it shipped once, was fixed on the path that had it,
 * and came back on the three paths added next to it. Three siblings,
 * one of which cleared the latch, is what "fixed case by case" looks
 * like.
 *
 * So the latch is not something a caller remembers. Both halves live
 * here: PLANNER_NOT_TOLD is the only place the filter is written, and
 * handLeafToPlanner is the only place a leaf is moved into a state the
 * filter has to find. A fifth such path gets the clearing by using the
 * function, and a path that writes the status by hand is visibly not
 * this one.
 */

/** Anything that can write these tables: the pool, or a transaction on it. */
export type TaskWriter = Pick<Db, "update" | "insert">;

/**
 * How many times one piece of news is handed to a fresh planner after
 * the planner it went to ended without deciding. Counted on the leaf as
 * `plannerRetells`, and cleared with the latch when the leaf has new
 * news. Without a bound, a planner that fails every time (a refused key,
 * a provider that stays down past the coordinator's own restarts) is
 * woken again by its own failure's tick, forever, and every one is
 * billed.
 */
export const MAX_PLANNER_RETELLS = 3;

/** The flags to clear whenever a leaf's news is new, so the latch and its count start over. */
export const PLANNER_LATCH_CLEARED = {
  plannerToldAt: undefined,
  plannerToldBy: undefined,
  plannerRetells: undefined,
} as const;

/**
 * The half of the wake's query that the latch is: leaves whose news has
 * not been folded into a wake yet, or whose wake never reached a planner.
 *
 * Read with coalesce rather than `is null`, because the latch is a key
 * in a jsonb column: a row that never had it and a row whose value was
 * set to null both read as "not told", and only a string means told.
 *
 * Told means told by a planner that finished its turn. The wake stamps
 * `plannerToldBy` with the run it started, and a run that then failed or
 * was cancelled never read the news it was handed: a planner stranded in
 * its sandbox, killed by a restart, or stopped by a person. Its leaves
 * read as not told again, so a later wake carries them. Before this,
 * such a leaf sat "working" with its report forever, and the swarm
 * waited on a decision nobody was ever asked to make.
 *
 * At most MAX_PLANNER_RETELLS times per piece of news. A leaf whose news
 * was lost that often waits for a person, as every leaf did before this.
 *
 * And told means decided. A planner that finished its turn but neither
 * accepted nor rejected a leaf's report (nor asked a person about it)
 * left the leaf "working" with its report, accepted by nobody, and every
 * later tick read it as told: the swarm waited, again, on a decision
 * nobody was ever going to make. Such a leaf is handed over again, said
 * as undecided in the wake, under the same bound. Only a report: a
 * failed leaf a planner chose to leave failed is a decision, and is how
 * a plan gives work up.
 *
 * A cancelled planner's news is found here too, but deliverPlannerWake
 * does not start a planner for it alone: a person who stopped the
 * planner chose to, and the news rides along with the next wake that
 * something else causes.
 *
 * Read here rather than cleared on each path that ends a planner run,
 * for the reason this file exists: a latch every terminal path has to
 * remember to clear is a latch one of them forgets. A run that is still
 * active does not count as failed, so a planner mid turn keeps its news.
 *
 * Only for a leaf still waiting on that decision: one still working on
 * its report, or one that failed. Not one already accepted, whose branch
 * is in the merge queue and whose landing speaks for it next (a second
 * planner told about it could reject work that is already landing), and
 * not one a person marked done or that landed in the meantime.
 *
 * The run id is cast to uuid, guarded, so the lookup is the primary key
 * rather than a scan of agent_runs per leaf, and a malformed flag reads
 * as no run rather than failing the tick.
 */
export const PLANNER_NOT_TOLD = sql`(
  coalesce((${swarmTasks.flags} ->> 'plannerToldAt'), '') = ''
  or (
    ${swarmTasks.status} in ('working', 'failed')
    and coalesce((${swarmTasks.flags} ->> 'accepted'), '') <> 'true'
    and (case when jsonb_typeof(${swarmTasks.flags} -> 'plannerRetells') = 'number'
      then (${swarmTasks.flags} ->> 'plannerRetells')::numeric else 0 end) < ${MAX_PLANNER_RETELLS}
    and exists (
      select 1 from ${agentRuns}
      where ${agentRuns.id} = (case
          when (${swarmTasks.flags} ->> 'plannerToldBy') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (${swarmTasks.flags} ->> 'plannerToldBy')::uuid
        end)
        and (
          ${agentRuns.status} in ('failed', 'cancelled')
          or (
            ${agentRuns.status} = 'succeeded'
            and ${swarmTasks.status} = 'working'
            and ${swarmTasks.report} is not null
            and ${swarmTasks.attention} is distinct from 'question'
          )
        )
    )
  )
)`;

/**
 * A leaf whose news has been handed over MAX_PLANNER_RETELLS times and
 * is still waiting on a decision: a report nobody accepted or rejected,
 * from a planner run that is over. The filter above stops finding it,
 * so this is the leaf a person has to decide about, and the tick raises
 * its attention so the board says so rather than nothing.
 */
export const PLANNER_RETELLS_EXHAUSTED = sql`(
  ${swarmTasks.nodeType} = 'leaf'
  and ${swarmTasks.status} = 'working'
  and ${swarmTasks.report} is not null
  and ${swarmTasks.attention} is null
  and coalesce((${swarmTasks.flags} ->> 'accepted'), '') <> 'true'
  and coalesce((${swarmTasks.flags} ->> 'plannerToldAt'), '') <> ''
  and (case when jsonb_typeof(${swarmTasks.flags} -> 'plannerRetells') = 'number'
    then (${swarmTasks.flags} ->> 'plannerRetells')::numeric else 0 end) >= ${MAX_PLANNER_RETELLS}
  and exists (
    select 1 from ${agentRuns}
    where ${agentRuns.id} = (case
        when (${swarmTasks.flags} ->> 'plannerToldBy') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${swarmTasks.flags} ->> 'plannerToldBy')::uuid
      end)
      and ${agentRuns.status} in ('succeeded', 'failed', 'cancelled')
  )
)`;

/**
 * The planner's verdict, which goes whenever a leaf is moved back to
 * failed or assigned. An `accepted` left on a leaf that failed to land
 * hid it from PLANNER_NOT_TOLD (an accepted leaf is the merge queue's),
 * made the planner's reject refuse it as "already accepted", and read
 * on the board as a branch waiting to land.
 */
export const ACCEPTANCE_CLEARED = { accepted: undefined, acceptNote: undefined } as const;

/** The leaf as read, minus the verdict, for a caller that rewrites its flags from it. */
export function withoutAcceptance<T extends { flags: Record<string, unknown> }>(task: T): T {
  return { ...task, flags: { ...task.flags, ...ACCEPTANCE_CLEARED } };
}

export interface LeafHandover {
  /** The leaf as it was read: its current status, and its flags. */
  task: typeof swarmTasks.$inferSelect;
  /** The state to move it into. */
  status: (typeof swarmTasks.$inferSelect)["status"];
  /** Why it wants a person, or null when it does not. */
  attention: (typeof swarmTasks.$inferSelect)["attention"];
  /** Flags to add. Whatever is passed, the latch is cleared. */
  flags?: Record<string, unknown>;
  /** Columns this particular handover also writes. */
  set?: Partial<typeof swarmTasks.$inferInsert>;
  /** What the event log says happened. */
  detail: Record<string, unknown>;
  /** The run that caused this, when one did. */
  runId?: string | null;
  now: Date;
}

/**
 * Moves one leaf into a state the planner has to be told about, clears
 * the latch that would otherwise hide it, and records the change.
 *
 * The board event is the caller's: some of them have a transaction to
 * commit first and some are collecting events for a tick to emit, and
 * an event emitted from in here would be emitted before the writes it
 * describes are visible.
 */
export async function handLeafToPlanner(tx: TaskWriter, hand: LeafHandover): Promise<void> {
  await tx
    .update(swarmTasks)
    .set({
      status: hand.status,
      attention: hand.attention,
      ...(hand.set ?? {}),
      /**
       * plannerToldAt goes, and it is the whole point of this function.
       * The leaf's news is new, so whatever the planner was told before
       * is not this.
       */
      flags: {
        ...hand.task.flags,
        ...hand.flags,
        // Back to failed or assigned is the verdict undone as well.
        ...(hand.status === "failed" || hand.status === "assigned" ? ACCEPTANCE_CLEARED : {}),
        ...PLANNER_LATCH_CLEARED,
      },
      updatedAt: hand.now,
    })
    .where(eq(swarmTasks.id, hand.task.id));
  await tx.insert(swarmTaskEvents).values({
    taskId: hand.task.id,
    kind: "status_changed",
    fromStatus: hand.task.status,
    toStatus: hand.status,
    ...(hand.runId ? { runId: hand.runId } : {}),
    detail: hand.detail,
  });
}
