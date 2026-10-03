import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentProfiles, agentRuns, swarmTasks, swarms, type Db } from "@bento/db";
import { modelPrice, routesToOllama, type ModelPrice } from "@bento/core";

/**
 * What a run cost, and how much that figure is worth.
 *
 * Only reported prices and estimates from reported tokens count toward
 * a swarm's dollar cap. A silent tool has unknown cost, so its run has
 * no dollar charge. Subscription list prices are recorded separately.
 *
 *   measured   the tool printed a price (Claude Code, pi)
 *   estimated  the tool printed tokens, priced from the model catalog
 *   notional   a printed price a subscription had already paid for
 *
 * The first two count against a budget. Notional does not: when a local
 * install lends a run the operator's logged in agent session, the tool
 * still prints its list price, but
 * the subscription has already paid for the work and the marginal cost
 * of the run is zero. Filing that as measured would put the least true
 * number in the most trusted tier and then stop a swarm that is costing
 * nothing.
 */

/** The tiers a new run may record. The database retains a legacy assumed value. */
export type CostTier = "measured" | "estimated" | "notional";

/** What the tool said, in the two shapes tools say it in. */
export interface ReportedUsage {
  costUsd?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface ChargeInput {
  reported: ReportedUsage;
  /** The model's list price, when the catalog carries one. */
  price?: ModelPrice | undefined;
  /** Whether this run borrowed a login instead of spending a key. */
  sharedAgentAuth: boolean;
}

/** One run's charge, as the columns record it. */
export interface RunCharge {
  tier: CostTier;
  usd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  pricePerMtok: ModelPrice | null;
}

/** Dollars per million tokens, which is how every provider quotes. */
const PER_MTOK = 1_000_000;

/**
 * Resolves one run's charge.
 *
 * In order, because the order is the confidence: a figure the tool
 * printed beats one worked out from its tokens. If neither is available,
 * the cost is unknown. Shared agent auth changes only
 * the tier, never the figure: what was spent is still recorded, it is
 * simply recorded as a list price somebody had already paid.
 *
 * Pure, and takes everything it needs, so the arithmetic can be tested
 * without a database, a sandbox, or a catalog.
 */
export function resolveCharge(input: ChargeInput): RunCharge | null {
  const notional = input.sharedAgentAuth;
  const reportedCost = input.reported.costUsd;
  if (typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0) {
    return {
      tier: notional ? "notional" : "measured",
      usd: reportedCost,
      inputTokens: tokenCount(input.reported.inputTokens),
      outputTokens: tokenCount(input.reported.outputTokens),
      pricePerMtok: null,
    };
  }

  const inputTokens = tokenCount(input.reported.inputTokens);
  const outputTokens = tokenCount(input.reported.outputTokens);
  const price = input.price;
  /*
   * Both halves of the answer, or neither. A price with no counts
   * prices nothing, and counts with no price would have to be
   * multiplied by a rate somebody invented. Either way its cost stays
   * unreported.
   */
  if (price && (inputTokens !== null || outputTokens !== null)) {
    const usd = ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / PER_MTOK;
    return {
      tier: notional ? "notional" : "estimated",
      usd,
      inputTokens,
      outputTokens,
      // The rate that produced the figure, kept with it: catalog prices
      // change, and a number that moves afterwards is a number nobody
      // can reconcile against a bill.
      pricePerMtok: { input: price.input, output: price.output },
    };
  }

  return null;
}

/** A count Bento will multiply, or null. Negatives and NaN are not counts. */
function tokenCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * The average of runs that reported a usable cost in this swarm.
 *
 * Used only to warn the planner when the remaining budget is below an
 * observed run's average. It is never recorded as a silent run's cost.
 */
export async function observedAverageRunCost(
  db: Pick<Db, "select">,
  swarm: { id: string },
): Promise<number> {
  const [averaged] = await db
    .select({ average: sql<string | null>`avg(${agentRuns.costUsd})` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.swarmId, swarm.id),
        inArray(agentRuns.costTier, ["measured", "estimated"]),
        isNotNull(agentRuns.costUsd),
      ),
    );
  const average = averaged?.average === null || averaged?.average === undefined ? null : Number(averaged.average);
  if (average !== null && Number.isFinite(average) && average > 0) return average;
  return 0;
}

/**
 * The charge for one run that is ending, read from its own rows.
 *
 * Everything the resolution needs that is not in the outcome comes off
 * the run: which agent it ran as (for the model and price), and whether
 * it borrowed a login. Nothing is passed down from the executor, so a
 * second caller cannot get a different answer by forgetting an
 * argument.
 *
 * Null when no usable cost was reported or can be priced from tokens.
 * Pipeline runs keep their existing rule of requiring a reported cost.
 */
export async function chargeForRun(
  db: Pick<Db, "select">,
  runId: string,
  reported: ReportedUsage,
): Promise<RunCharge | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      type: agentRuns.type,
      sharedAgentAuth: agentRuns.sharedAgentAuth,
      cli: agentProfiles.cli,
      model: agentProfiles.model,
    })
    .from(agentRuns)
    .innerJoin(agentProfiles, eq(agentProfiles.id, agentRuns.agentProfileId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) return null;

  /*
   * A run on a local model is not a token bill at all.
   *
   * Nothing is charged for it, in any tier. The machine costs what it
   * costs whether the agent runs or not, no provider invoices anybody,
   * and the figure a tool prints for an Ollama run is a Claude price
   * for work Claude never did, which trustedCostUsd already refuses to
   * record. A local model with no provider bill remains unreported.
   */
  if (routesToOllama(run.cli, run.model)) return null;

  const price = modelPrice(run.cli, run.model);
  const hasFigure = typeof reported.costUsd === "number" && Number.isFinite(reported.costUsd);
  if (run.type !== "swarm" && !hasFigure) return null;
  return resolveCharge({ reported, price, sharedAgentAuth: run.sharedAgentAuth });
}

/**
 * Adds a finished run's charge to the node it worked and to the swarm
 * that paid for it.
 *
 * Added rather than recomputed, and the swarm's own totals are the
 * authority rather than a sum of its tree. A planner turn and a merge
 * queue resolver belong to no node, so a swarm total derived from the
 * tree would leave out the two roles that cost the most and hand the
 * budget a figure that is quietly too small. The tree's figures answer
 * a different question, which is what each piece of work cost.
 *
 * Once per run by construction: the only caller is behind finishRun's
 * compare and set, which exactly one path wins.
 */
export async function applyRunCharge(
  db: Pick<Db, "update">,
  run: { swarmId: string | null; swarmTaskId: string | null },
  charge: RunCharge,
): Promise<void> {
  if (!run.swarmId || charge.usd <= 0) return;
  const amount = String(charge.usd);
  const now = new Date();
  /*
   * One named column per tier, written out rather than looked up.
   * Four columns and four tiers is a short list, and a lookup keyed on
   * a string is how a tier nobody added a column for would silently
   * write nowhere.
   */
  await db
    .update(swarms)
    .set({
      ...(charge.tier === "measured" ? { spentMeasuredUsd: sql`${swarms.spentMeasuredUsd} + ${amount}` } : {}),
      ...(charge.tier === "estimated" ? { spentEstimatedUsd: sql`${swarms.spentEstimatedUsd} + ${amount}` } : {}),
      ...(charge.tier === "notional" ? { spentNotionalUsd: sql`${swarms.spentNotionalUsd} + ${amount}` } : {}),
      updatedAt: now,
    })
    .where(eq(swarms.id, run.swarmId));
  if (!run.swarmTaskId) return;
  await db
    .update(swarmTasks)
    .set({
      ...(charge.tier === "measured" ? { costMeasuredUsd: sql`${swarmTasks.costMeasuredUsd} + ${amount}` } : {}),
      ...(charge.tier === "estimated" ? { costEstimatedUsd: sql`${swarmTasks.costEstimatedUsd} + ${amount}` } : {}),
      ...(charge.tier === "notional" ? { costNotionalUsd: sql`${swarmTasks.costNotionalUsd} + ${amount}` } : {}),
      updatedAt: now,
    })
    .where(eq(swarmTasks.id, run.swarmTaskId));
}

/** A swarm's spend, as every reader of it wants it: four figures, no total. */
export interface SwarmSpend {
  measured: number;
  estimated: number;
  assumed: number;
  notional: number;
}

export function spendOf(swarm: {
  spentMeasuredUsd: string | number;
  spentEstimatedUsd: string | number;
  spentAssumedUsd: string | number;
  spentNotionalUsd: string | number;
}): SwarmSpend {
  return {
    measured: Number(swarm.spentMeasuredUsd) || 0,
    estimated: Number(swarm.spentEstimatedUsd) || 0,
    assumed: Number(swarm.spentAssumedUsd) || 0,
    notional: Number(swarm.spentNotionalUsd) || 0,
  };
}

/**
 * What the budget counts: reported prices and estimates from reported
 * tokens. Legacy assumed charges and subscription list prices are excluded.
 */
export function enforcedSpend(spend: SwarmSpend): number {
  return spend.measured + spend.estimated;
}

/**
 * Whether this swarm has room for one more run, and what to say if it
 * has not.
 *
 * "One more run" is the whole shape of the promise a budget can keep.
 * A run's cost is not known until it ends, so concurrent runs can take
 * reported spend past the cap. An agent is never killed for money.
 *
 * Silent tools cannot provide a reliable dollar cap. Their runs stay
 * unreported, while agent hours and the configured worker limit still
 * bound how much work may run at once.
 */
export function budgetRefusal(
  swarm: { budgetUsd: string | null; spentMeasuredUsd: string; spentEstimatedUsd: string; spentAssumedUsd: string; spentNotionalUsd: string },
): string | null {
  if (swarm.budgetUsd === null) return null;
  const cap = Number(swarm.budgetUsd);
  /*
   * Zero is a real cap, not the absence of one. Treating it as
   * unlimited let a swarm that deliberately allowed no additional
   * spend start agents. An invalid or negative value is failed closed
   * too: routes reject it, but a malformed imported row must not turn
   * into an unlimited budget.
   */
  if (!Number.isFinite(cap) || cap < 0) {
    return "This swarm has an invalid budget. Set a valid budget to let it carry on; what has landed is kept.";
  }
  const spent = enforcedSpend(spendOf(swarm));
  if (spent < cap) return null;
  const note = `This swarm has spent its ${money(cap)} budget (${money(spent)} so far).`;
  return `${note} Raise the budget to let it carry on; what has landed is kept.`;
}

/**
 * Whether the planner should be told the money is nearly gone.
 *
 * Below one average run, because that is the point at which the next
 * thing the planner does is the last thing it gets to do, and a
 * planner that knows it can prioritize rather than spending the
 * remainder on whatever came next in the tree.
 */
export function budgetIsLow(
  swarm: { budgetUsd: string | null; spentMeasuredUsd: string; spentEstimatedUsd: string; spentAssumedUsd: string; spentNotionalUsd: string },
  averageRunUsd: number,
): boolean {
  if (swarm.budgetUsd === null) return false;
  const cap = Number(swarm.budgetUsd);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const remaining = cap - enforcedSpend(spendOf(swarm));
  return remaining > 0 && remaining < Math.max(averageRunUsd, 0);
}

/** Dollars as the product prints them, in a sentence a person reads. */
export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
