import type { SwarmFlag } from "../beta.js";
import { useBillingPlan, type PlanState } from "../components/billing-plan.js";
import { estimateLine } from "./money.js";
import type { SwarmSpend } from "./types.js";

/**
 * Whether this install offers swarms at all, and what to say when it
 * does not.
 *
 * One decision, taken once, from the plan the billing module sends.
 * The console is the same console in both of Bento's deployment
 * modes: local mode has one user, no organization, no plan and no
 * billing, and a hosted team has all four. That is a difference in
 * what the plan says, not a difference in screens, so everything
 * below reads state rather than branching into a second console.
 */

export type BentoMode = "local" | "multi";

export interface SwarmAccess {
  /** Whether this team's plan includes swarms, or the plan is still in flight. */
  plan: "loading" | "included" | "excluded";
  /** Whether this person is the one who could change that. */
  canUpgrade: boolean;
}

/** Where the prompt sends somebody. The same deep link billing emails use. */
export const BILLING_HREF = "/settings?tab=billing";

/**
 * The plan's half of the gate.
 *
 * Local mode has one user, no organization and no plan, so nothing is
 * gated there; neither is an install with no billing module. A plan
 * from a billing module that predates swarms says nothing about them,
 * and absent is not "no": refusing on a field the module has not
 * started sending yet would turn a deploy order into a feature being
 * switched off.
 */
export function swarmAccess(input: {
  mode: BentoMode;
  plan: PlanState | null;
  /** True on an install with no billing module at all. */
  absent: boolean;
}): SwarmAccess {
  const open: SwarmAccess = { plan: "included", canUpgrade: false };
  if (input.mode === "local") return open;
  if (input.absent) return open;
  if (!input.plan) return { plan: "loading", canUpgrade: false };
  if (input.plan.swarms === undefined || input.plan.swarms.included) return open;
  return { plan: "excluded", canUpgrade: input.plan.canManageBilling };
}

/**
 * What the Swarms tab shows. The tab is there for everyone; this says
 * what is behind it. A subscription comes first, then the hosted
 * waitlist, and a flag that could not be read is never read as allowed.
 */
export type SwarmGate = "loading" | "open" | "subscribe" | "waitlist" | "unavailable";

export function swarmGate(access: SwarmAccess, flag: SwarmFlag | null): SwarmGate {
  if (access.plan === "loading") return "loading";
  if (access.plan === "excluded") return "subscribe";
  if (flag === null) return "loading";
  return flag;
}

/**
 * The three places local mode differs, named rather than scattered.
 *
 * Everything else is identical, and these are stated as absences so a
 * test can assert them one by one: the creation dialog drops the plan
 * footer and the agent hours line, and the swarm header never carries
 * the out of compute banner. The dollar estimate stays in both, and
 * is the whole cost story in local mode.
 */
export interface ModeSurfaces {
  planFooter: boolean;
  agentHoursLine: boolean;
  outOfComputeBanner: boolean;
  dollarEstimate: boolean;
  /**
   * Workers a new swarm starts with: two on a local install, where each
   * one is a build on the machine somebody is typing on, and four on a
   * hosted one, where each is its own machine. The server's default is
   * the same pair, so a swarm created without the dialog matches.
   */
  defaultSwarmWorkers: number;
}

export function modeSurfaces(mode: BentoMode): ModeSurfaces {
  return {
    planFooter: mode === "multi",
    agentHoursLine: mode === "multi",
    outOfComputeBanner: mode === "multi",
    dollarEstimate: true,
    defaultSwarmWorkers: mode === "multi" ? 4 : 2,
  };
}

/**
 * The plan state every swarm surface reads, as one hook.
 *
 * The gate, the mode's surfaces and the plan itself come back
 * together, so no component works any of it out a second time and
 * local mode never grows a screen of its own.
 */
export function useSwarmPlan(mode: BentoMode): {
  access: SwarmAccess;
  surfaces: ModeSurfaces;
  plan: PlanState | null;
} {
  const { plan, absent } = useBillingPlan();
  return { access: swarmAccess({ mode, plan, absent }), surfaces: modeSurfaces(mode), plan };
}

/**
 * What the New swarm dialog says about money, in order.
 *
 * This is where local mode's two absences actually live, so they can
 * be asserted rather than reasoned about: a hosted team gets the
 * estimate, the agent hours line and the plan footer, and local mode
 * gets the estimate alone. It has no organization, no plan and no
 * agent hour pool, so both of the other lines would be describing
 * something that is not there.
 */
export interface CreationNote {
  id: "estimate" | "agent-hours" | "plan-footer";
  text: string;
  /** The estimate is the figure; the rest are asides. */
  emphasis: boolean;
}

export function creationNotes(
  surfaces: ModeSurfaces,
  estimate: SwarmSpend,
  leaves: number,
): CreationNote[] {
  const notes: CreationNote[] = [];
  if (surfaces.dollarEstimate) {
    notes.push({ id: "estimate", text: estimateLine(estimate, leaves), emphasis: true });
  }
  if (surfaces.agentHoursLine) {
    notes.push({
      id: "agent-hours",
      text: "Sandbox time counts against this team's agent hours, the same as a card's run.",
      emphasis: false,
    });
  }
  if (surfaces.planFooter) {
    notes.push({
      id: "plan-footer",
      text: "Spend and hours land on this team's plan. See Settings, Billing for what is left this period.",
      emphasis: false,
    });
  }
  return notes;
}
