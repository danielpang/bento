import { eq } from "drizzle-orm";
import { getAdapter } from "@bento/agents";
import { agentProfiles, agentRuns } from "@bento/db";
import type { AppContext } from "../context.js";
import { nudgeRun } from "./run-ownership.js";

/** How long a message route waits for another server to take a message. */
export const REMOTE_DELIVERY_WAIT_MS = 1_000;
const REMOTE_DELIVERY_POLL_MS = 100;

/**
 * Tells whichever process holds the run that a message row is waiting,
 * then watches the row for the holder's answer.
 *
 * The route that enqueued the row cannot see the holder's stdin, so it
 * cannot know at once whether the message went in. The holder's pump
 * marks the row sent when it has, usually within a hundred milliseconds
 * of the nudge, and the row is the one record both servers share. So
 * the route asks the row a few times, for about a second, and answers
 * live when it says sent. A run with no live session anywhere leaves
 * the row queued, and the route says so, as it always did.
 *
 * Called after the row's transaction has committed: before that, the
 * holder could not see the row to claim it.
 */
export async function nudgeAndAwaitSent(
  ctx: AppContext,
  runId: string,
  isSent: () => Promise<boolean>,
  waitMs: number = REMOTE_DELIVERY_WAIT_MS,
): Promise<boolean> {
  nudgeRun(ctx, runId);
  const deadline = Date.now() + waitMs;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, REMOTE_DELIVERY_POLL_MS));
    if (await isSent()) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * How a run's tool treats a message that arrives mid task, read from
 * the adapter of the profile the run was started with: what the route
 * would have read off the local live handle, had it held one.
 */
export async function liveDeliveryOf(ctx: AppContext, runId: string): Promise<"steer" | "queue" | null> {
  const [row] = await ctx.db
    .select({ cli: agentProfiles.cli })
    .from(agentRuns)
    .innerJoin(agentProfiles, eq(agentProfiles.id, agentRuns.agentProfileId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!row) return null;
  try {
    return getAdapter(row.cli as Parameters<typeof getAdapter>[0]).live?.delivery ?? null;
  } catch {
    return null;
  }
}
