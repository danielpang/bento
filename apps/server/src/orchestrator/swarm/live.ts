import { and, eq, inArray } from "drizzle-orm";
import { shouldHoldPlannerSession } from "@bento/core";
import { swarmTasks, swarms } from "@bento/db";
import type { AppContext } from "../../context.js";
import { isBetaRun } from "../../feature-flags.js";
import type { LiveConversation } from "../live-session.js";
import type { SwarmSubject } from "../run-subject.js";
import { enqueueSwarmTick } from "./coordinator.js";
import { claimNodeMessages, requeueSwarmMessages } from "./node-messages.js";

/**
 * How a swarm's agents hold a live stdin conversation, where cards
 * have held one for a while.
 *
 * A swarm run used to be headless even on an adapter that could keep
 * a session open: every message to the planner woke its machine, spawned
 * the CLI, and resumed the session for one turn, and a message to a
 * worker waited for the next agent on the leaf. Now:
 *
 * - The planner stays open between turns while its workers are still
 *   going (`shouldHoldPlannerSession`), and the coordinator delivers
 *   its folded wake (reports, failures, messages) into the process it
 *   already has. A person's message reaches it the same way, through
 *   the tick its message enqueues. The hold is re-decided after every
 *   turn, so it ends by itself once there is nobody to wait for, and
 *   the machine goes back to sleep.
 * - A worker hears a message on its node while it works, queued behind
 *   its current turn by the adapter, and closes as soon as a turn ends
 *   with nothing waiting: its finish is what tells the planner about
 *   its report, so it is never held.
 * - Every other role (judge, resolver, subplanner) is headless and
 *   closes stdin after its first turn.
 *
 * Behind the beta testers flag like every capability handed to an
 * agent, because a held planner is a held machine.
 */

/** The leaves whose agents the planner is waiting on. */
const LEAVES_IN_PROGRESS = ["assigned", "working"] as const;

export function plannerConversation(ctx: AppContext, input: { swarmId: string; idleSec: number }): LiveConversation {
  return {
    // Nothing parks on the planner itself: the coordinator folds what
    // people and workers said into one wake and delivers it through
    // the executor's handle once the hold is armed (see onWaiting).
    claim: async () => [],
    markSent: async () => {},
    requeue: async () => {},
    holdFor: async (ok) => {
      if (!ok || input.idleSec <= 0) return 0;
      const [swarm] = await ctx.db
        .select({ status: swarms.status })
        .from(swarms)
        .where(eq(swarms.id, input.swarmId))
        .limit(1);
      if (!swarm) return 0;
      const leaves = await ctx.db
        .select({ id: swarmTasks.id })
        .from(swarmTasks)
        .where(
          and(
            eq(swarmTasks.swarmId, input.swarmId),
            eq(swarmTasks.nodeType, "leaf"),
            inArray(swarmTasks.status, [...LEAVES_IN_PROGRESS]),
          ),
        );
      return shouldHoldPlannerSession({
        ok,
        swarmStatus: swarm.status,
        leavesInProgress: leaves.length,
        idleSec: input.idleSec,
      })
        ? input.idleSec
        : 0;
    },
    waitingNotice: (seconds) => {
      const window = seconds % 60 === 0 && seconds >= 120 ? `${seconds / 60} minutes` : `${seconds} seconds`;
      return (
        "The planner is waiting on its workers. Each report reaches it here as it arrives, and a message you send reaches it in this session. " +
        `The run ends after ${window} with nothing to do.`
      );
    },
    /*
     * The hold is armed: anything that folded up while the turn ran (a
     * worker that reported meanwhile, a message a person sent) is
     * delivered by the tick this asks for.
     *
     * Best effort. It runs inside the agent's event handler, so a throw
     * here (a pool timeout after a suspend) would fail a planner run that
     * is fine. The watchdog ticks every live swarm once a minute, which
     * delivers whatever this one would have.
     */
    onWaiting: async () => {
      try {
        await enqueueSwarmTick(ctx, input.swarmId);
      } catch (err) {
        console.warn(`could not enqueue a tick for swarm ${input.swarmId} as its planner began to wait:`, err);
        ctx.analytics?.captureException(err, null, null, { swarm_id: input.swarmId, source: "planner_hold" });
      }
    },
  };
}

export function workerConversation(
  ctx: Pick<AppContext, "db">,
  input: { taskId: string; runId: string },
): LiveConversation {
  return {
    // Bound to this run as they are claimed, so a crash before the write
    // leaves them on a run whose end puts them back.
    claim: () => claimNodeMessages(ctx.db, input.taskId, input.runId),
    markSent: async () => {},
    requeue: (ids) => requeueSwarmMessages(ctx.db, ids),
    // Never held: the run's end is what hands its report to the planner.
    holdFor: async () => 0,
    waitingNotice: () => "",
  };
}

/**
 * The conversation this swarm run holds, or null for a role nobody
 * talks to. Null still gets a headless conversation from the executor,
 * so its stdin is closed after its first turn.
 */
export async function swarmLiveConversation(
  ctx: AppContext,
  subject: SwarmSubject,
): Promise<LiveConversation | null> {
  const { run, task } = subject;
  if (run.role !== "planner" && !(run.role === "worker" && task)) return null;
  const beta = await isBetaRun(ctx, { actingUserId: run.startedBy, projectOwnerId: subject.project.ownerId });
  if (!beta) return null;
  if (run.role === "planner") {
    return plannerConversation(ctx, { swarmId: subject.swarm.id, idleSec: ctx.env.BENTO_SWARM_PLANNER_HOLD_SEC });
  }
  return workerConversation(ctx, { taskId: task!.id, runId: run.id });
}
