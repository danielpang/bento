import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { featureMessages, type Db } from "@bento/db";

/**
 * The lifecycle of a message to a card's agent, over the
 * feature_messages table.
 *
 * A message is queued until a run takes it, sent while exactly one run
 * holds it, and delivered once a result event from that run confirms a
 * turn completed with the message on the conversation. Every terminal
 * path puts a run's still-sent messages back to queued, so "the agent
 * never read it" always ends in redelivery rather than in a message
 * that exists only as a transcript line nobody answered.
 *
 * Claims take FOR UPDATE SKIP LOCKED, so two paths draining the same
 * card (a finishing run and the message route, for instance) split the
 * queue instead of double-sending it.
 */

export interface ClaimedMessage {
  id: string;
  text: string;
  /** Who wrote it, so a continuation run acts with their MCP connections. */
  userId: string | null;
}

/** Parks a message on the card. The row is the message's identity. */
export async function enqueueMessage(
  db: Db,
  featureId: string,
  text: string,
  userId: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(featureMessages)
    .values({ featureId, text, userId })
    .returning({ id: featureMessages.id });
  if (!row) throw new Error("message insert returned no row");
  return row.id;
}

/**
 * Takes every queued message on the card, oldest first. The rows move
 * to sent with no run yet; the caller either assigns them to the run
 * that will carry them (markMessagesSent) or puts them back
 * (requeueMessages). A claim left dangling by a crash between those two
 * steps is swept back to queued at boot.
 */
export async function claimQueuedMessages(db: Db, featureId: string): Promise<ClaimedMessage[]> {
  const result = await db.execute(sql`
    update feature_messages set status = 'sent', sent_at = now()
    where id in (
      select id from feature_messages
      where feature_id = ${featureId} and status = 'queued'
      for update skip locked
    )
    returning id, text, user_id, created_at
  `);
  const rows =
    (result as unknown as {
      rows?: { id: string; text: string; user_id: string | null; created_at: string | Date }[];
    }).rows ?? [];
  return rows
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((row) => ({ id: row.id, text: row.text, userId: row.user_id }));
}

/**
 * Binds claimed messages to the run carrying them, still awaiting a
 * result to confirm them. Only for messages written into a live
 * session's stdin: those are the ones a process can die without ever
 * reading. A message that becomes a run's prompt is delivered outright
 * (see markMessagesDelivered).
 */
export async function markMessagesSent(db: Db, ids: string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  await db.update(featureMessages).set({ runId }).where(inArray(featureMessages.id, ids));
}

/**
 * Hands messages to the run they became the prompt of, finished.
 *
 * A prompt is not a message in flight: agent_runs.prompt carries the
 * text durably, and the run exists whatever happens to it next. Leaving
 * these as "sent" made every run that ended before emitting a result
 * requeue its own prompt, which the terminal path immediately turned
 * into another identical run, and that one failed the same way: cards
 * with a persistent failure (no credentials, a sandbox that will not
 * provision) span an endless chain of runs. A run that fails is a
 * failure to read and resume, not a message to deliver again.
 */
export async function markMessagesDelivered(db: Db, ids: string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(featureMessages)
    .set({ status: "delivered", runId, deliveredAt: new Date() })
    .where(inArray(featureMessages.id, ids));
}

/** Puts claimed messages back for the next taker, order preserved. */
export async function requeueMessages(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(featureMessages)
    .set({ status: "queued", runId: null, sentAt: null })
    .where(inArray(featureMessages.id, ids));
}

/**
 * A result event from the run: every message it was carrying has been
 * on the conversation for a completed turn, which is as close to "the
 * agent heard it" as a CLI without acks can say.
 */
export async function confirmDelivered(db: Db, runId: string): Promise<void> {
  await db
    .update(featureMessages)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(and(eq(featureMessages.runId, runId), eq(featureMessages.status, "sent")));
}

/**
 * The run ended with messages still unconfirmed: whatever it was
 * doing, no turn completed after they arrived, so they go back to
 * queued and the next run gets them. At-least-once on purpose; a rare
 * duplicate is visible in the transcript, a loss is invisible.
 */
export async function requeueUndelivered(db: Db, runId: string): Promise<void> {
  await db
    .update(featureMessages)
    .set({ status: "queued", runId: null, sentAt: null })
    .where(and(eq(featureMessages.runId, runId), eq(featureMessages.status, "sent")));
}

/**
 * Boot sweep, half one: claims a dead process left dangling (sent with
 * no run assigned) go back to queued. Half two, sent rows whose run is
 * already terminal, is swept by the caller with a join it owns.
 */
export async function requeueDanglingClaims(db: Db): Promise<void> {
  await db
    .update(featureMessages)
    .set({ status: "queued", sentAt: null })
    .where(and(eq(featureMessages.status, "sent"), isNull(featureMessages.runId)));
}
