import { and, asc, eq, inArray } from "drizzle-orm";
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
