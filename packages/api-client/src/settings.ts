export interface PlanPricing {
  /** Dollars per seat per month. Null when the plan is a conversation. */
  perSeatUsd: number | null;
  /** Whether that number is a floor rather than the price. */
  fromPrice: boolean;
  minimumSeats: number;
  /** The team's pool for the period, whatever its headcount. */
  includedAgentHours: number;
  overageUsdPerAgentHour: number | null;
  summary: string;
  highlights: string[];
}

export interface PlanOffer {
  plan: string;
  name: string;
  pricing: PlanPricing;
  limits: { members: number | null };
  /** Seats this team would be billed for on this plan, given its headcount. */
  billableSeats: number;
  /** What this team would pay a month on this plan. */
  monthlyTotalUsd: number | null;
}

export interface PlanState {
  plan: string;
  planName: string;
  status: string | null;
  limits: { members: number | null };
  usage: { members: number };
  /**
   * Sandbox time this period against what the plan includes. `cap` is
   * the number agents actually stop at, and it is null for a team
   * paying its overage instead. The period runs from the
   * organization's own anniversary, never a calendar month.
   */
  agentHours: { used: number; included: number; cap: number | null; periodStart: string; periodEnd: string };
  /**
   * Whether new runs are being refused right now, and by which wall.
   * Server computed from the same refusals the gate applies, so this
   * cannot disagree with what actually happens when a run asks.
   */
  stopped: "ceiling" | "pool" | null;
  /**
   * What this team has chosen to happen at the end of its allowance.
   * `changeable` is false on Free, which has no subscription for an
   * overage to land on and so has nothing to allow.
   */
  overage: {
    policy: "stop" | "allow";
    changeable: boolean;
    usdPerAgentHour: number | null;
    /** The most this team will pay past the allowance; null for none. */
    ceilingUsd: number | null;
    /** What the overage has come to so far this period. */
    spentUsd: number;
  };
  /**
   * Who spent the hours. Null user means a run nobody started: a stage
   * handed on by the evaluator, or a judge agent.
   *
   * The name is the one recorded when the run finished, not one looked
   * up now, so a month's usage still names the people who spent it
   * after they have left and agrees with the invoice that charged for
   * them.
   */
  usageByMember: { userId: string | null; name: string | null; agentHours: number }[];
  /**
   * Which cards spent the hours this billing month. Prefer this over
   * usageByMember: a team of forty people is still a handful of cards
   * doing the work, and "who used it" on a board is the card.
   *
   * Absent when the billing module has not started sending it; the
   * console then rolls the period (from periodStart) up from runs.
   */
  usageByFeature?: { featureId: string; title: string; agentHours: number }[];
  /**
   * Whether this plan includes swarms. Sent by the billing module, so
   * an install without one leaves it absent and the console falls back
   * to whatever the server's own gate answers. Nothing renders from it
   * yet; the type is here so the module and the console agree on the
   * name before either uses it.
   */
  swarms?: { included: boolean };
  seats: { held: number; billable: number; monthlyTotalUsd: number | null; billed: boolean };
  catalog: PlanOffer[];
  activity?: {
    activity: string;
    fromPlan: string | null;
    toPlan: string | null;
    amountTotal: number | null;
    currency: string | null;
    occurredAt: string;
  }[];
  canManageBilling: boolean;
  upgradable: boolean;
  manageable: boolean;
  salesConfigured: boolean;
}

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}
export interface AccountSession {
  user: AccountUser;
  session: { id: string; activeOrganizationId?: string | null };
}
export interface Organization {
  id: string;
  name: string;
  slug: string;
}
export interface OrganizationMember {
  id: string;
  userId: string;
  role: string;
  user: AccountUser;
}
export interface OrganizationInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  organizationId: string;
  organizationName?: string;
}
export interface OrganizationDetails extends Organization {
  members: OrganizationMember[];
  invitations: OrganizationInvitation[];
}
export interface TeamPolicy {
  restrictNetwork: boolean;
  canEdit: boolean;
  supported: boolean;
}
