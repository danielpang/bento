import { sql } from "drizzle-orm";
import { agentRuns, runEvents } from "@bento/db";
import type { AgentEvent } from "@bento/core";
import type { AppContext } from "../context.js";
import { recordedRunEvent } from "../events.js";
import { disownRun, ownedByMeOrNobody, yielded } from "./run-ownership.js";

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
  // Nor does a server for a run another one adopted from it.
  if (yielded(ctx, runId)) return;
  /**
   * For a run this process drives, the owner check rides on the insert
   * itself: the row lands only if the run is still this process's
   * (ownedByMeOrNobody). A process whose lease was taken while it was
   * suspended would otherwise land one more line before its heartbeat
   * told it, and the database is the one place that knows the answer
   * at the instant of the write. Zero rows back means exactly that,
   * and the process disowns the run on the spot.
   *
   * A line written about a run this process does not drive (the reaper
   * closing a run that stalled on another server, a runner's run) is
   * not guarded: those writers never owned the run and were never the
   * second loop this exists to stop.
   */
  const driving = ctx.ownership?.owned.has(runId) === true;
  const owner = driving ? ownedByMeOrNobody(ctx) : sql`true`;
  for (let attempt = 0; ; attempt++) {
    try {
      const inserted = await ctx.db.execute<{ seq: number | string; recordedAt: Date | string }>(sql`
        insert into ${runEvents} (${sql.identifier("run_id")}, ${sql.identifier("seq")}, ${sql.identifier("type")}, ${sql.identifier("payload")})
        select ${runId}::uuid, next.seq, ${event.type}, ${JSON.stringify(event)}::jsonb
        from (
          select coalesce(max(${runEvents.seq}), 0) + 1 as seq
          from ${runEvents}
          where ${runEvents.runId} = ${runId}::uuid
        ) as next
        where exists (select 1 from ${agentRuns} where ${agentRuns.id} = ${runId}::uuid and ${owner})
        returning ${runEvents.seq} as seq, ${runEvents.ts} as "recordedAt"
      `);
      const row = inserted.rows[0];
      if (!row) {
        if (driving) disownRun(ctx, runId);
        return;
      }
      ctx.bus.emitRunEvent({ runId, seq: Number(row.seq), event: recordedRunEvent({ payload: event, ts: row.recordedAt }) });
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
