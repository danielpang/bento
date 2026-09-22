import { capUse, cappedUsd, formatUsd, spendParts, tierLabel } from "../swarm/money.js";
import { SPEND_TIERS } from "../swarm/layout.js";
import type { SpendTier, SwarmSpend, SwarmTask } from "../swarm/types.js";

/**
 * What this swarm is costing, by role and by how well each figure is
 * known.
 *
 * The header already carries the totals. This is the panel a person
 * opens when the total is not the question: where the money went, and
 * how much of the number is real.
 *
 * Nothing here ever adds the tiers together. A measurement, an
 * arithmetic estimate, a stand in figure and a list price a
 * subscription had already paid for are four different kinds of
 * confidence, and one number carrying all four next to a cap people set
 * real limits with is the thing this whole design exists to avoid.
 */

/** The roles a swarm's money goes to, in the order they are printed. */
const ROLES = ["planner", "worker", "resolver"] as const;
export type SpendRole = (typeof ROLES)[number];

export interface RoleSpend {
  role: SpendRole;
  spend: SwarmSpend;
}

/**
 * What each role cost, from the tree and the swarm's own totals.
 *
 * A leaf's charges are its worker's, and what is left over once every
 * node is counted is what the planner and the merge queue's resolvers
 * spent: those runs hang off no node at all, which is exactly why the
 * swarm's totals are the authority and the tree is not.
 *
 * The remainder goes to the planner rather than being split between
 * the planner and resolvers, because nothing on the wire says which of
 * the two it was, and a split nobody can source is a number that looks
 * more precise than it is. A resolver's own charge lands on the leaf
 * it was resolving, which is where a person looks for it.
 */
export function spendByRole(total: SwarmSpend, tasks: SwarmTask[]): RoleSpend[] {
  const worker = tasks.reduce<SwarmSpend>(
    (sum, task) => ({
      measuredUsd: sum.measuredUsd + task.cost.measuredUsd,
      estimatedUsd: sum.estimatedUsd + task.cost.estimatedUsd,
      assumedUsd: sum.assumedUsd + task.cost.assumedUsd,
      notionalUsd: sum.notionalUsd + task.cost.notionalUsd,
    }),
    { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 },
  );
  const planner: SwarmSpend = {
    measuredUsd: Math.max(0, total.measuredUsd - worker.measuredUsd),
    estimatedUsd: Math.max(0, total.estimatedUsd - worker.estimatedUsd),
    assumedUsd: Math.max(0, total.assumedUsd - worker.assumedUsd),
    notionalUsd: Math.max(0, total.notionalUsd - worker.notionalUsd),
  };
  return [
    { role: "planner", spend: planner },
    { role: "worker", spend: worker },
  ];
}

/** What a role is called, in the sentence a person would use. */
function roleWords(role: SpendRole): string {
  if (role === "planner") return "Planning";
  if (role === "worker") return "Working the tasks";
  return "Resolving conflicts";
}

/** The widest tier figure, so every bar is drawn to one scale. */
function widest(rows: RoleSpend[]): number {
  let most = 0;
  for (const row of rows) {
    for (const tier of SPEND_TIERS) {
      const usd = tierOf(row.spend, tier);
      if (usd > most) most = usd;
    }
  }
  return most;
}

function tierOf(spend: SwarmSpend, tier: SpendTier): number {
  if (tier === "measured") return spend.measuredUsd;
  if (tier === "estimated") return spend.estimatedUsd;
  if (tier === "assumed") return spend.assumedUsd;
  return spend.notionalUsd;
}

/**
 * The spend of a swarm over time, as one line.
 *
 * A sparkline rather than a chart, because the only question it
 * answers is whether spend is flat, climbing steadily, or has just
 * gone vertical, and that is a shape rather than a set of readings.
 * Built from the nodes that have finished, in the order they finished,
 * which is the closest thing to a clock the plan carries.
 */
export function spendOverTime(tasks: SwarmTask[]): number[] {
  const finished = tasks
    .filter((task) => task.endedAt !== null && task.nodeType === "leaf")
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  const points: number[] = [];
  let running = 0;
  for (const task of finished) {
    /*
     * What the cap counts, and only that.
     *
     * A cumulative line has to accumulate something, so the one figure
     * it may accumulate is the one that means something on its own:
     * the three tiers somebody is actually billed for, which is what
     * the budget is compared against. The fourth is a list price a
     * subscription had already paid for, and running it into this
     * total put four kinds of confidence behind one number and then
     * read that number out as what the swarm ended at.
     */
    running += cappedUsd(task.cost);
    points.push(running);
  }
  return points;
}

export function SwarmCostPanel({
  spend,
  tasks,
  budgetUsd,
}: {
  spend: SwarmSpend;
  tasks: SwarmTask[];
  budgetUsd: number | null;
}) {
  const rows = spendByRole(spend, tasks);
  const scale = widest(rows);
  const cap = capUse(spend, budgetUsd);
  const points = spendOverTime(tasks);

  return (
    <section className="swarm-costs" aria-label="Spend">
      <header className="swarm-costs-head">
        <span className="label">Spend by role</span>
        <span className="muted">{cap.capLine}</span>
      </header>

      <ul className="swarm-cost-roles">
        {rows.map((row) => (
          <li key={row.role}>
            <span className="swarm-cost-role">{roleWords(row.role)}</span>
            <ul className="swarm-cost-bars">
              {SPEND_TIERS.map((tier) => {
                const usd = tierOf(row.spend, tier);
                return (
                  <li key={tier} title={`${formatUsd(usd)} ${tierLabel(tier)}`}>
                    <span className="swarm-cost-bar">
                      <span
                        className="swarm-cost-fill"
                        data-tier={tier}
                        style={{ width: scale > 0 ? `${(usd / scale) * 100}%` : "0%" }}
                      />
                    </span>
                    <span className="swarm-tier-label">{tierLabel(tier)}</span>
                    <span className="swarm-tier-value spend-figure">{formatUsd(usd)}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      {points.length > 1 && <SpendSparkline points={points} />}

      {/*
       * The two things a total cannot say for itself.
       *
       * A cap enforced against mostly assumed figures is a cap
       * enforced against a guess, and somebody who set a budget
       * deserves to know that while the swarm is running rather than
       * afterwards. And a swarm spending a subscription is not
       * spending money at all, so its cap warns instead of stopping
       * it, which would otherwise look like a budget that does not
       * work.
       */}
      {cap.soft && (
        <p className="swarm-cost-note" role="note">
          More than a quarter of this figure was assumed rather than reported, so the cap is soft.
          Tools that print what they cost make it exact.
        </p>
      )}
      {cap.notional && (
        <p className="swarm-cost-note" role="note">
          Some of these runs used your own signed in agent, so their cost is a list price your
          subscription has already paid. It is shown as notional and does not count against the
          budget, which warns rather than stopping this swarm.
        </p>
      )}
    </section>
  );
}

/**
 * The shape of the spend so far.
 *
 * Drawn as a path with no axes and no labels, because it is not a
 * chart: the figures are printed in full above it, and the only thing
 * this adds is whether the line is flat, climbing, or has just turned
 * upwards.
 */
export function SpendSparkline({ points }: { points: number[] }) {
  const width = 220;
  const height = 28;
  const most = Math.max(...points, 0.0001);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)} ${(height - (point / most) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      className="swarm-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      // Says which figure it is reading out. A bare "ending at $6.00"
      // is the one thing a total may never be here: a number with no
      // word saying how well it is known.
      aria-label={`Spend the budget counts, over time, ending at ${formatUsd(points[points.length - 1] ?? 0)}`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** The header's own line: every tier, apart, with the cap beside them. */
export function SwarmSpendLine({ spend }: { spend: SwarmSpend }) {
  return (
    <ul className="swarm-tiers swarm-tiers-inline">
      {spendParts(spend).map((part) => (
        <li key={part.tier} title={part.note}>
          <span className="swarm-tier-value spend-figure">{formatUsd(part.usd)}</span>
          <span className="swarm-tier-label">{part.label}</span>
        </li>
      ))}
    </ul>
  );
}
