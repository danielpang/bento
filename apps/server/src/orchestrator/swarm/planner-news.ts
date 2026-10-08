import { eq, sql } from "drizzle-orm";
import { swarmTaskEvents, swarmTasks, type Db } from "@bento/db";

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
 * read as not told again, so the next tick wakes a planner about them.
 * Before this, such a leaf sat "working" with its report forever, and
 * the swarm waited on a decision nobody was ever asked to make.
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
 */
export const PLANNER_NOT_TOLD = sql`(
  coalesce((${swarmTasks.flags} ->> 'plannerToldAt'), '') = ''
  or (
    ${swarmTasks.status} in ('working', 'failed')
    and coalesce((${swarmTasks.flags} ->> 'accepted'), '') <> 'true'
    and exists (
      select 1 from agent_runs told_by
      where told_by.id::text = (${swarmTasks.flags} ->> 'plannerToldBy')
        and told_by.status in ('failed', 'cancelled')
    )
  )
)`;

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
      flags: { ...hand.task.flags, ...hand.flags, plannerToldAt: undefined, plannerToldBy: undefined },
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
