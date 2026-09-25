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
 * not been folded into a wake yet.
 *
 * Read with coalesce rather than `is null`, because the latch is a key
 * in a jsonb column: a row that never had it and a row whose value was
 * set to null both read as "not told", and only a string means told.
 */
export const PLANNER_NOT_TOLD = sql`coalesce((${swarmTasks.flags} ->> 'plannerToldAt'), '') = ''`;

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
      flags: { ...hand.task.flags, ...hand.flags, plannerToldAt: undefined },
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
