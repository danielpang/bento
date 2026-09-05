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
  /** Whether the mode toggle is rendered at all. */
  show: boolean;
  /** Whether picking Swarms opens a board rather than an upgrade prompt. */
  included: boolean;
  /** Whether this person is the one who could change that. */
  canUpgrade: boolean;
  /** The prompt's sentence, or null when there is nothing to prompt. */
  prompt: string | null;
}

/** Where the prompt sends somebody. The same deep link billing emails use. */
export const BILLING_HREF = "/settings?tab=billing";

/**
 * The gate.
 *
 * Four answers, and the quiet one matters most: while the plan is
 * still in flight nothing renders, the same way the beta flag hides
 * until it has resolved. A toggle that appears and then turns into an
 * upgrade prompt is worse than one that arrives a moment late.
 *
 * A team without swarms on its plan sees the toggle only if somebody
 * there can act on it. Showing a member a control that can only ever
 * refuse them is an advertisement, not a feature.
 */
export function swarmAccess(input: {
  mode: BentoMode;
  plan: PlanState | null;
  /** True on an install with no billing module at all. */
  absent: boolean;
}): SwarmAccess {
  const open: SwarmAccess = { show: true, included: true, canUpgrade: false, prompt: null };
  // One user, no organization, no plan: nothing to gate on.
  if (input.mode === "local") return open;
  // An install that carries no billing module has no plan ladder, so
  // the server's own gate is the only gate there is.
  if (input.absent) return open;
  if (!input.plan) {
    return { show: false, included: false, canUpgrade: false, prompt: null };
  }
  /*
   * A plan from a billing module that predates swarms says nothing
   * about them. Absent is not "no": refusing on a field the module
   * has not started sending yet would turn a deploy order into a
   * feature being switched off.
   */
  if (input.plan.swarms === undefined) return open;
  if (input.plan.swarms.included) return open;
  const canUpgrade = input.plan.canManageBilling;
  return {
    show: canUpgrade,
    included: false,
    canUpgrade,
    prompt: canUpgrade
      ? `Swarms are not on the ${input.plan.planName} plan. Upgrading turns them on for this team.`
      : null,
  };
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
}

export function modeSurfaces(mode: BentoMode): ModeSurfaces {
  return {
    planFooter: mode === "multi",
    agentHoursLine: mode === "multi",
    outOfComputeBanner: mode === "multi",
    dollarEstimate: true,
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
