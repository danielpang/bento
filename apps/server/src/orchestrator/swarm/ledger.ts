import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentProfiles, agentRuns, swarmTasks, swarmTemplates, swarms, type Db } from "@bento/db";
import { modelPrice, routesToOllama, type ModelPrice } from "@bento/core";

/**
 * What a run cost, and how much that figure is worth.
 *
 * Bento has always recorded spend and never enforced it. A swarm is the
 * first place a cap has to hold, because it is the first place one
 * click starts twenty agents, and the difficulty is that only some
 * tools say what they cost. Adding a measurement, an arithmetic
 * estimate and a guess into one number would produce a figure whose
 * accuracy nobody could state, printed beside a budget people set real
 * limits with. So this module produces four figures and never a total,
 * and every reader carries them apart.
 *
 *   measured   the tool printed a price (Claude Code, pi)
 *   estimated  the tool printed tokens, priced from the model catalog
 *   assumed    the tool printed nothing, so a figure stands in
 *   notional   a printed price a subscription had already paid for
 *
 * The first three are the budget's. The fourth is not, and that is the
 * whole point of it: when a local install lends a run the operator's
 * logged in agent session, the tool still prints its list price, but
 * the subscription has already paid for the work and the marginal cost
 * of the run is zero. Filing that as measured would put the least true
 * number in the most trusted tier and then stop a swarm that is costing
 * nothing.
 */

/** How well a figure is known. The column's own vocabulary. */
export type CostTier = "measured" | "estimated" | "assumed" | "notional";

/**
 * What a run that reports nothing is charged when there is nothing
 * else to go on: no figure on the template, and no run in this swarm
 * that was ever measured or estimated.
 *
 * A number rather than zero, because zero is the one answer that is
 * certainly wrong: a run happened, and a swarm whose every tool is
 * silent would otherwise run forever against any budget.
 */
export const DEFAULT_ASSUMED_USD = 0.5;

/** The three tiers a budget counts. Notional is recorded and never capped. */
export const ENFORCED_TIERS = ["measured", "estimated", "assumed"] as const;

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
  /** What a silent run costs here. See assumedCostFor. */
  assumedUsd: number;
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
 * printed beats one worked out from its tokens, which beats one that
 * had to be assumed. Shared agent auth is asked last and changes only
 * the tier, never the figure: what was spent is still recorded, it is
 * simply recorded as a list price somebody had already paid.
 *
 * Pure, and takes everything it needs, so the arithmetic can be tested
 * without a database, a sandbox, or a catalog.
 */
export function resolveCharge(input: ChargeInput): RunCharge {
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
   * multiplied by a rate somebody invented. Either way the run falls
   * to the assumed tier, which says exactly that: this figure is a
   * stand in.
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

  return {
    tier: notional ? "notional" : "assumed",
    usd: Math.max(0, input.assumedUsd),
    inputTokens,
    outputTokens,
    pricePerMtok: null,
  };
}

/** A count Bento will multiply, or null. Negatives and NaN are not counts. */
function tokenCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * What a silent run costs in this swarm.
 *
 * Three answers, in order. The template's own figure, because a team
 * that states one knows their tools better than an average does. Then
 * this swarm's rolling average of the runs it actually measured or
 * estimated, which is the honest stand in: it is what this swarm's own
 * agents have been costing. Then the fixed default, for the swarm whose
 * first run is the silent one.
 *
 * The average is over this swarm alone rather than the deployment,
 * because a swarm is one template, one pair of models and one goal, and
 * a cheap swarm must not inherit an expensive one's history.
 */
export async function assumedCostFor(
  db: Pick<Db, "select">,
  swarm: { id: string; templateId: string | null },
): Promise<number> {
  if (swarm.templateId) {
    const [template] = await db
      .select({ assumedCostUsd: swarmTemplates.assumedCostUsd })
      .from(swarmTemplates)
      .where(eq(swarmTemplates.id, swarm.templateId))
      .limit(1);
    const stated = template?.assumedCostUsd === null || template?.assumedCostUsd === undefined
      ? null
      : Number(template.assumedCostUsd);
    if (stated !== null && Number.isFinite(stated) && stated >= 0) return stated;
  }

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
  return DEFAULT_ASSUMED_USD;
}

/**
 * The charge for one run that is ending, read from its own rows.
 *
 * Everything the resolution needs that is not in the outcome comes off
 * the run: which agent it ran as (for the model, and so for the price),
 * which swarm it belongs to (for the assumed figure), and whether it
 * borrowed a login. Nothing is passed down from the executor, so a
 * second caller cannot get a different answer by forgetting an
 * argument.
 *
 * Null for a pipeline run that reported nothing at all, and that is
 * deliberate: the card board's spend has always been "what the tools
 * printed", stated as a floor, and inventing an assumed figure there
 * would change every total on the Spend page into a number nobody
 * asked for. A card's run is tiered only when it actually reported.
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
      swarmId: agentRuns.swarmId,
      swarmTaskId: agentRuns.swarmTaskId,
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
   * record. Charging it the assumed figure instead would be the same
   * invention wearing a different word, and it would stop a swarm that
   * is spending nothing.
   */
  if (routesToOllama(run.cli, run.model)) return null;

  const price = modelPrice(run.cli, run.model);
  const hasFigure = typeof reported.costUsd === "number" && Number.isFinite(reported.costUsd);
  if (run.type !== "swarm") {
    if (!hasFigure) return null;
    return resolveCharge({ reported, price, sharedAgentAuth: run.sharedAgentAuth, assumedUsd: 0 });
  }

  const [swarm] = await db
    .select({ id: swarms.id, templateId: swarms.templateId })
    .from(swarms)
    .where(eq(swarms.id, run.swarmId!))
    .limit(1);
  // The swarm went while its run was ending. Nothing to charge it to.
  if (!swarm) return null;
  const assumedUsd = await assumedCostFor(db, swarm);
  return resolveCharge({ reported, price, sharedAgentAuth: run.sharedAgentAuth, assumedUsd });
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
      ...(charge.tier === "assumed" ? { spentAssumedUsd: sql`${swarms.spentAssumedUsd} + ${amount}` } : {}),
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
      ...(charge.tier === "assumed" ? { costAssumedUsd: sql`${swarmTasks.costAssumedUsd} + ${amount}` } : {}),
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
 * What the budget counts: the three tiers somebody is actually billed
 * for. Notional is left out here and nowhere else, which is the one
 * place that rule is written down.
 */
export function enforcedSpend(spend: SwarmSpend): number {
  return spend.measured + spend.estimated + spend.assumed;
}

/**
 * Whether this swarm has room for one more run, and what to say if it
 * has not.
 *
 * "One more run" is the whole shape of the promise a budget can keep.
 * A run's cost is not known until it ends, so a cap can be exceeded by
 * at most the run that was already going when it was reached, and an
 * agent is never killed for money: an agent stopped mid edit leaves a
 * branch nobody chose, and the time it spent is spent either way.
 */
export function budgetRefusal(
  swarm: { budgetUsd: string | null; spentMeasuredUsd: string; spentEstimatedUsd: string; spentAssumedUsd: string; spentNotionalUsd: string },
): string | null {
  if (swarm.budgetUsd === null) return null;
  const cap = Number(swarm.budgetUsd);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const spent = enforcedSpend(spendOf(swarm));
  if (spent < cap) return null;
  return `This swarm has spent its ${money(cap)} budget (${money(spent)} so far). Raise the budget to let it carry on; what has landed is kept.`;
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
