import { sql } from "drizzle-orm";
import { runEvents } from "@bento/db";
import type { AgentEvent } from "@bento/core";
import type { AppContext } from "../context.js";

/**
 * Appends one event to a run's transcript and announces it on the bus.
 * Every transcript write goes through here, because the sequence number
 * is allocated by the database rather than by a counter in process
 * memory.
 *
 * Counters looked safe: each run has exactly one driving loop. A
 * restart breaks that assumption. The old process keeps its loop alive
 * through the shutdown grace while the new process reattaches to the
 * same agent and starts its own, and for a few seconds two counters
 * write one transcript. Their first collision on the (run_id, seq)
 * unique index threw out of the losing loop's onEvent, which failed the
 * run and silently dropped the agent's message: a user once saw their
 * agent's answer only inside the error text of the insert that lost it.
 *
 * Two writers can still compute the same next seq at once; that
 * surfaces as a unique violation and retries, because the failed insert
 * wrote nothing and trying again is safe. Every collision means some
 * other writer landed its row, so with n concurrent writers a writer
 * retries at most n times; the cap is a backstop well past any real
 * fan-in, not a budget. Anything else propagates.
 */
export async function appendRunEvent(ctx: AppContext, runId: string, event: AgentEvent): Promise<void> {
  // A draining server writes nothing: its successor owns the transcript
  // now, and a late write from this side would race the successor's.
  if (ctx.draining) return;
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await ctx.db
        .insert(runEvents)
        .values({
          runId,
          seq: sql<number>`(select coalesce(max(${runEvents.seq}), 0) + 1 from ${runEvents} where ${runEvents.runId} = ${runId})`,
          type: event.type,
          payload: event,
        })
        .returning({ seq: runEvents.seq });
      ctx.bus.emitRunEvent({ runId, seq: row!.seq, event });
      return;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 50) throw err;
    }
  }
}

/**
 * Postgres says 23505; the driver and drizzle each wrap the error, so
 * the code is found wherever it sits on the cause chain.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
