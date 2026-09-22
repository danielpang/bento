import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, swarmMessages, swarmTaskEvents, swarmTasks, swarms, type Db } from "@bento/db";
import { ACTIVE_RUN_STATUSES } from "../start-run.js";
import { budgetRefusal, enforcedSpend, money, spendOf } from "./ledger.js";
import { quoteUntrusted } from "./planner-prompt.js";

/**
 * Taking a finished swarm up again.
 *
 * A swarm ends and its branch sits in the repository with a pull
 * request open on it. Then the review comes back, or somebody thinks
 * of the thing nobody thought of, and the work is the same work: same
 * branch, same plan, same pull request. Starting a second swarm would
 * give it a second branch and a second pull request over the first
 * one's change, and a reviewer would have two to read and no way to
 * tell which was current.
 *
 * So a reopen is the same swarm, carried on. Three things follow from
 * that and they are the whole of this file.
 *
 * **The follow up is a subtree, not a new plan.** One plan node at the
 * top of the tree, holding the instruction it was reopened with, and
 * everything the planner does about it goes underneath. The first
 * pass's leaves are left exactly as they are: they are done, and a
 * reopen is not a retraction of them. This is also what lets both
 * views label the follow up: the node carries the instruction, and
 * every node under it is inside that subtree.
 *
 * **The ledger and the clock carry forward.** Nothing here resets a
 * spend column, because the money was spent: a swarm that cost forty
 * dollars and is reopened has cost forty dollars, and a budget raised
 * to sixty buys twenty more. A swarm reopened with neither raised is
 * refused rather than started, because the coordinator would spawn
 * nothing and the person would be left watching a swarm that says it
 * is running and never moves.
 *
 * **The pull requests are updated, not replaced.** Nothing here does
 * that; it is what not changing the branch buys. The swarm keeps its
 * branch name, `swarm_pull_requests` is keyed on the swarm and the
 * repository url, and the publish that runs when the reopened swarm
 * finishes upserts that row and asks GitHub for the pull request
 * already open on the branch. The one thing a reopen must not do,
 * therefore, is give the swarm a new branch.
 *
 * The planner is told rather than restarted. It hears the instruction
 * through the ordinary wake message, which is the same door a person's
 * message goes through: quoted as somebody else's words, alongside a
 * notice from Bento naming the node to put the work under. On a
 * harness that can resume a session it resumes; on one that cannot it
 * starts again with the design note it wrote the first time, which is
 * what read_design is for.
 */

/** The states a swarm can be taken up again from. */
export const REOPENABLE_STATUSES = ["done", "failed", "cancelled", "budget_exhausted", "timed_out"] as const;

type Swarm = typeof swarms.$inferSelect;

/** Anything that can write these tables: the pool, or a transaction on it. */
export type ReopenWriter = Pick<Db, "select" | "update" | "insert">;

export interface ReopenInput {
  /** What the follow up is for, as the person wrote it. */
  instruction: string;
  /** A raised budget, in dollars, or undefined to leave it alone. */
  budgetUsd?: number | null | undefined;
  /** A raised wall clock limit, in minutes, or undefined. */
  timeLimitMin?: number | null | undefined;
  actorUserId?: string | null;
  now?: Date;
}

export interface Reopened {
  swarm: Swarm;
  /** The plan node the follow up hangs off. */
  followUpTaskId: string;
  /** Which follow up this is: 1 for the first. */
  followUp: number;
}

/** Why this swarm cannot be reopened, in words the caller can act on. */
export type ReopenRefusal = { refused: string; code: "NOT_FINISHED" | "BUDGET" | "TIME_LIMIT" };

/**
 * Whether a reopen would actually start anything, and what to say when
 * it would not.
 *
 * Asked before anything is written, because the alternative is a swarm
 * put back into "running" that the coordinator then refuses to spawn
 * on, with nothing on the board saying why. Both ceilings are checked
 * against what the reopen was given rather than against what the swarm
 * holds: raising the budget in the same call is the ordinary way to
 * reopen a swarm that ran out of money.
 */
export function reopenRefusal(swarm: Swarm, input: Pick<ReopenInput, "budgetUsd" | "timeLimitMin">): ReopenRefusal | null {
  if (!(REOPENABLE_STATUSES as readonly string[]).includes(swarm.status)) {
    return {
      refused: `This swarm is ${swarm.status}, so there is nothing to reopen. Reopening is for a swarm that has finished.`,
      code: "NOT_FINISHED",
    };
  }

  const budgetUsd = input.budgetUsd === undefined ? swarm.budgetUsd : input.budgetUsd === null ? null : String(input.budgetUsd);
  const refusal = budgetRefusal({ ...swarm, budgetUsd });
  if (refusal) {
    const spent = money(enforcedSpend(spendOf(swarm)));
    return {
      refused: `This swarm has already spent ${spent}, which is its whole budget, so a follow up would start nothing. Raise the budget as part of reopening it.`,
      code: "BUDGET",
    };
  }

  /*
   * The clock is measured from the swarm's first agent and counts
   * every minute since, paused ones included, so a swarm that timed
   * out is past its limit for good. Reopening it without raising the
   * limit hands it straight back to the watchdog.
   */
  if (swarm.status === "timed_out") {
    const raised = input.timeLimitMin;
    if (raised === undefined || (raised !== null && swarm.timeLimitMin !== null && raised <= swarm.timeLimitMin)) {
      return {
        refused:
          "This swarm ran past its time limit, and the limit counts every minute since its first agent, so a follow up would be stopped again at once. Raise the time limit as part of reopening it, or clear it.",
        code: "TIME_LIMIT",
      };
    }
  }
  return null;
}

/**
 * Puts a finished swarm back to work under a follow up node.
 *
 * Everything in one transaction, because a swarm that is running with
 * no follow up node is a swarm whose planner is about to be woken with
 * nothing to do, and a follow up node under a swarm that is still done
 * is work nothing will ever pick up.
 */
export async function reopenSwarm(
  tx: ReopenWriter,
  swarm: Swarm,
  input: ReopenInput,
): Promise<Reopened | ReopenRefusal> {
  const refusal = reopenRefusal(swarm, input);
  if (refusal) return refusal;

  const now = input.now ?? new Date();
  const instruction = input.instruction.trim();
  const followUp = swarm.reopenCount + 1;

  const [{ next } = { next: 0 }] = await tx
    .select({ next: sql<number>`coalesce(max(${swarmTasks.position}), -1) + 1` })
    .from(swarmTasks)
    .where(and(eq(swarmTasks.swarmId, swarm.id), sql`${swarmTasks.parentId} is null`));

  /*
   * A plan node rather than a leaf. The planner decides what the
   * follow up actually involves, which is the same decision it makes
   * about the goal, and a leaf here would either be worked before the
   * planner had read anything or sit assigned to nobody. Open, so the
   * rollup counts it as work still to come.
   */
  const [node] = await tx
    .insert(swarmTasks)
    .values({
      swarmId: swarm.id,
      parentId: null,
      position: next,
      nodeType: "plan",
      status: "open",
      title: `Follow up ${followUp}`,
      description: instruction,
      followUpInstruction: instruction,
    })
    .returning();
  if (!node) throw new Error("reopening a swarm inserted no follow up node");

  await tx.insert(swarmTaskEvents).values({
    taskId: node.id,
    kind: "created",
    toStatus: node.status,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    detail: { followUp },
  });

  /*
   * Two messages, and they are different kinds of thing.
   *
   * The instruction is a person's own words and goes in as a person's
   * message, so the wake prints it under "messages from people" and
   * quotes it: it is input, and the planner weighs it rather than
   * obeying anything it might contain about its own tools.
   *
   * The notice is Bento's, about rows it holds: which node the work
   * goes under, and that the branch and its pull requests are the ones
   * that already exist. It carries the instruction quoted inside it
   * for the same reason a report is quoted when a notice carries one.
   */
  await tx.insert(swarmMessages).values({
    swarmId: swarm.id,
    text: instruction,
    source: "person",
    ...(input.actorUserId ? { userId: input.actorUserId } : {}),
  });
  await tx.insert(swarmMessages).values({
    swarmId: swarm.id,
    source: "system",
    text: followUpNotice({ nodeId: node.id, followUp, instruction, branch: swarm.branchName }),
  });

  const [updated] = await tx
    .update(swarms)
    .set({
      /*
       * Running rather than planning. There is already a plan and
       * work that landed under it; what is new is one node nobody has
       * decomposed yet, and the coordinator spawns from "running".
       */
      status: "running",
      pausedReason: null,
      reopenCount: followUp,
      // A swarm somebody is working again is not put away, whatever
      // they did with it when it finished.
      archivedAt: null,
      ...(input.budgetUsd === undefined
        ? {}
        : {
            budgetUsd: input.budgetUsd === null ? null : String(input.budgetUsd),
            // A raised budget is a different budget, so running low on
            // it is news again. Same rule the PATCH route follows.
            budgetWarnedAt: null,
          }),
      ...(input.timeLimitMin === undefined ? {} : { timeLimitMin: input.timeLimitMin }),
      updatedAt: now,
    })
    .where(eq(swarms.id, swarm.id))
    .returning();
  if (!updated) throw new Error("reopening a swarm updated no row");

  return { swarm: updated, followUpTaskId: node.id, followUp };
}

/**
 * What Bento tells the planner about a reopen.
 *
 * Written here rather than inline so the sentence a planner reads is
 * one thing a test can hold. It says three things and nothing else:
 * where the work goes, that the earlier work stands, and that the
 * branch and its pull requests are the ones already open.
 */
export function followUpNotice(input: {
  nodeId: string;
  followUp: number;
  instruction: string;
  branch: string | null;
}): string {
  return [
    `This swarm has been reopened. A plan node, ${input.nodeId}, has been added at the top of the tree for follow up ${input.followUp}, and everything you decide about it goes underneath that node.`,
    "What the person asked for:",
    quoteUntrusted(input.instruction),
    "Everything the swarm finished before this stands. Do not reopen, retry, or cancel a task that is already done unless the instruction above asks you to.",
    input.branch
      ? `The work carries on the same branch, ${input.branch}, and the pull requests it already opened are updated rather than replaced. Nothing you do opens a second one.`
      : "The work carries on the swarm's own branch, and the pull requests it already opened are updated rather than replaced.",
    "Read your design note before you plan, so this follow up sits on top of what you decided the first time rather than beside it.",
  ].join("\n\n");
}

/**
 * The ids of every node inside a follow up's subtree, the follow up
 * node included.
 *
 * Walked one level at a time and bounded by the tree's depth, the way
 * descendantIds is. Used by anything that has to say which follow up a
 * node belongs to without the console having to walk parents itself.
 */
export async function followUpSubtree(tx: Pick<Db, "select">, nodeId: string): Promise<string[]> {
  const found = [nodeId];
  let frontier = [nodeId];
  for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
    const rows = await tx.select({ id: swarmTasks.id }).from(swarmTasks).where(inArray(swarmTasks.parentId, frontier));
    frontier = rows.map((row) => row.id);
    found.push(...frontier);
  }
  return found;
}

/**
 * Whether this swarm still has an agent going, which a reopen has to
 * know: a finished swarm whose last worker has not settled is one the
 * coordinator is still about to hear from.
 *
 * Its own function because the route and the tests both ask it, and
 * because the list of active statuses belongs in one place.
 */
export async function swarmHasActiveRun(tx: Pick<Db, "select">, swarmId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmId, swarmId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  return Boolean(row);
}
