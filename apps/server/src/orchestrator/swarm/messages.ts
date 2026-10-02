import { and, eq } from "drizzle-orm";
import { swarmMessages, swarmTasks, swarms, type Db } from "@bento/db";

type Writer = Pick<Db, "insert" | "update">;

/**
 * Records a person's answer through the one path shared by the console,
 * terminal, and Slack.
 *
 * Clearing the wait is part of recording the answer. Leaving that to a
 * client made a Slack reply reach the planner while the board stayed
 * yellow, and a task-scoped answer never cleared its question at all.
 */
export async function recordSwarmAnswer(
  db: Writer,
  input: { swarmId: string; taskId?: string | null; text: string; userId: string },
) {
  const [message] = await db
    .insert(swarmMessages)
    .values({
      swarmId: input.swarmId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      text: input.text,
      userId: input.userId,
      source: "person",
    })
    .returning();
  if (!message) throw new Error("the swarm answer inserted no row");
  await db
    .update(swarms)
    .set({ pausedReason: null, updatedAt: new Date() })
    .where(and(eq(swarms.id, input.swarmId), eq(swarms.pausedReason, "attention")));
  if (input.taskId) {
    await db
      .update(swarmTasks)
      .set({ attention: null, updatedAt: new Date() })
      .where(and(eq(swarmTasks.id, input.taskId), eq(swarmTasks.swarmId, input.swarmId)));
  }
  return message;
}
