import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { swarmMessages, type Db } from "@bento/db";

/**
 * Messages people leave on one node, and how they reach an agent.
 *
 * A swarm's worker is headless. It holds no live session, so unlike a
 * card's agent there is no channel to write into while it works, and
 * nothing a person types can reach it between the moment it starts and
 * the moment it reports. The rows wait instead, and the next agent put
 * on the leaf is handed them in its prompt: that is the agent that can
 * actually act on what was said, and the node drawer's composer
 * promises exactly that rather than implying the words arrived.
 *
 * Messages addressed to the plan rather than to a node go somewhere
 * else entirely: the coordinator folds them into the planner's next
 * wake. The two are told apart by `task_id`, which is why the wake
 * query asks for the rows where it is null.
 */

/**
 * Takes the messages waiting on one node, oldest first, and marks them
 * delivered to the run that is about to carry them.
 *
 * Delivered rather than sent, which is the distinction the card's
 * message lifecycle draws and for the same reason: these become part
 * of `agent_runs.prompt`, which is durable, so the text exists whatever
 * happens to the run next. Left as "sent" they would be redelivered to
 * the run after this one, and a leaf that keeps being sent back would
 * show its agent the same note every time.
 */
export async function takeNodeMessages(
  db: Db,
  taskId: string,
  runId: string,
): Promise<{ text: string }[]> {
  const waiting = await db
    .select({ id: swarmMessages.id, text: swarmMessages.text })
    .from(swarmMessages)
    .where(and(eq(swarmMessages.taskId, taskId), eq(swarmMessages.status, "queued")))
    .orderBy(asc(swarmMessages.createdAt));
  if (waiting.length === 0) return [];
  const now = new Date();
  await db
    .update(swarmMessages)
    .set({ status: "delivered", runId, sentAt: now, deliveredAt: now })
    .where(
      inArray(
        swarmMessages.id,
        waiting.map((row) => row.id),
      ),
    );
  return waiting.map((row) => ({ text: row.text }));
}

/**
 * The same rows, when the leaf's agent can hear them: a worker on a
 * live adapter holds a stdin conversation, and a message sent while it
 * works is written there rather than parked for the next agent.
 *
 * The lifecycle mirrors a card's (orchestrator/messages.ts): queued
 * until a process takes it, sent while exactly one run holds it, and
 * delivered once a result from that run confirms a turn completed
 * with the message on the conversation. A run that ends with a message
 * still sent puts it back, so the next agent on the leaf is handed it
 * in its prompt the way it always was.
 */

/** Takes the messages waiting on one node for a live write, oldest first. */
export async function claimNodeMessages(db: Db, taskId: string): Promise<{ id: string; text: string }[]> {
  const waiting = await db
    .select({ id: swarmMessages.id, text: swarmMessages.text })
    .from(swarmMessages)
    .where(and(eq(swarmMessages.taskId, taskId), eq(swarmMessages.status, "queued")))
    .orderBy(asc(swarmMessages.createdAt));
  if (waiting.length === 0) return [];
  await db
    .update(swarmMessages)
    .set({ status: "sent", sentAt: new Date() })
    .where(inArray(swarmMessages.id, waiting.map((row) => row.id)));
  return waiting;
}

/** Binds messages written into a live session's stdin to the run that holds them. */
export async function bindSwarmMessages(db: Db, ids: string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(swarmMessages)
    .set({ status: "sent", runId, sentAt: new Date() })
    .where(inArray(swarmMessages.id, ids));
}

/** Puts messages a write could not deliver back for the next taker. */
export async function requeueSwarmMessages(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(swarmMessages)
    .set({ status: "queued", runId: null, sentAt: null })
    .where(inArray(swarmMessages.id, ids));
}

/**
 * A result event from the run: every message it was carrying, a
 * person's to the planner or to a node, has been on the conversation
 * for a completed turn.
 */
export async function confirmSwarmMessagesDelivered(db: Db, runId: string): Promise<void> {
  await db
    .update(swarmMessages)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(and(eq(swarmMessages.runId, runId), eq(swarmMessages.status, "sent")));
}

/**
 * The run ended with node messages still unconfirmed: no turn
 * completed after they arrived, so they go back to queued and the next
 * agent on the leaf is handed them. Only a node's: a planner's unread
 * messages are put back by the coordinator, which reads how the run
 * ended to decide whether they wake another planner.
 */
export async function requeueUndeliveredNodeMessages(db: Db, runId: string): Promise<void> {
  await db
    .update(swarmMessages)
    .set({ status: "queued", runId: null, sentAt: null })
    .where(
      and(
        eq(swarmMessages.runId, runId),
        eq(swarmMessages.status, "sent"),
        sql`${swarmMessages.taskId} is not null`,
      ),
    );
}
