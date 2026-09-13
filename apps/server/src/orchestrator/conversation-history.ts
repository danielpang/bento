import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { agentRuns, runEvents, type Db } from "@bento/db";
import { compactTranscript, type ConversationTurn } from "@bento/core";

/**
 * The spoken turns of a card's work, oldest first, excluding a run
 * that is still being assembled (its follow-up is the new prompt, not
 * history). Judge transcripts stay out: they are a verdict, not a
 * conversation the next agent should continue.
 */
export async function loadConversationTurns(
  db: Db,
  featureId: string,
  excludeRunId?: string,
): Promise<ConversationTurn[]> {
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, featureId), ne(agentRuns.role, "judge")))
    .orderBy(asc(agentRuns.queuedAt));
  const ids = runs.map((row) => row.id).filter((id) => id !== excludeRunId);
  if (ids.length === 0) return [];

  const rows = await db
    .select({ payload: runEvents.payload, ts: runEvents.ts, seq: runEvents.seq })
    .from(runEvents)
    .where(and(inArray(runEvents.runId, ids), eq(runEvents.type, "message")))
    .orderBy(asc(runEvents.ts), asc(runEvents.seq));

  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    const payload = row.payload as { role?: string; text?: string };
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const text = payload.text?.trim() ?? "";
    if (!text) continue;
    turns.push({ role: payload.role, text });
  }
  return turns;
}

/**
 * Compacted history for a follow-up that cannot resume a CLI session.
 * Empty when there is nothing to carry, so callers can pass it through.
 */
export async function compactedConversation(
  db: Db,
  featureId: string,
  excludeRunId?: string,
): Promise<string> {
  return compactTranscript(await loadConversationTurns(db, featureId, excludeRunId));
}
