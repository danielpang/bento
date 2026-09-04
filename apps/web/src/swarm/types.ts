/**
 * What the swarm endpoints answer with.
 *
 * The routes do not exist yet. This module is the shape they will
 * send, written down once so the console can be built and driven
 * today against `fixtures.ts` and switched to real fetches by
 * changing `client.ts` alone. The names are the table's, because the
 * swarm route answers with the row itself: `nodeType` here is
 * `swarm_tasks.node_type` there, and one vocabulary end to end is
 * what keeps the console reading what the server sends. Renaming a
 * field is a change on both sides, never on one.
 *
 * Two endpoints:
 *
 *   GET /api/projects/:id/swarms  ->  SwarmSummary[]   (the strip)
 *   GET /api/swarms/:id           ->  SwarmDetail      (the page)
 *
 * Everything an agent wrote (a title, a description, a report, a
 * flag's value) is untrusted text. It renders as text, and a report
 * renders through the markdown path with raw HTML off.
 */

/** Where a swarm is, as the strip's status dot reads it. */
export type SwarmStatus =
  | "planning"
  | "running"
  | "paused"
  | "waiting"
  | "done"
  | "stopped"
  | "budget_exhausted"
  | "failed";

/** A plan node is decomposed further. A leaf is what a worker is given. */
export type NodeType = "plan" | "leaf";

export type TaskStatus =
  | "open"
  | "assigned"
  | "working"
  | "landed"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled";

/**
 * Whether this node wants a person, which is a second axis and not a
 * status: a worker that has been going for an hour is still `working`.
 */
export type TaskAttention = "none" | "long_running" | "escalated";

/**
 * Money, always three figures.
 *
 * Measured is what a tool reported. Estimated is what the console
 * worked out from tokens at a published rate. Assumed is a template's
 * own guess for a tool that reports nothing at all. They are carried
 * apart and printed apart, and nothing here adds them: a single total
 * would be three different kinds of confidence wearing one number.
 */
export interface SwarmSpend {
  measuredUsd: number;
  estimatedUsd: number;
  assumedUsd: number;
}

/** A commit a worker pushed to its own branch, before the landing. */
export interface TaskCommit {
  sha: string;
  message: string;
  at: string;
}

export interface SwarmTask {
  id: string;
  /** Null at the top. The swarm itself is the root nobody stores. */
  parentId: string | null;
  /** Orders siblings, so the console never invents an order of its own. */
  position: number;
  title: string;
  description: string;
  nodeType: NodeType;
  status: TaskStatus;
  attention: TaskAttention;
  /** The planner's rough size, 1 to 5. Weights the rollup, never billed. */
  weight: number;
  assignedRunId: string | null;
  branchName: string | null;
  cost: SwarmSpend;
  /** Coordinator bookkeeping: retry counts, who blocked this, planner notes. */
  flags: Record<string, unknown>;
  /** What the worker said it did. Markdown, agent written. */
  report: string | null;
  /** What "done" means for this leaf, as the planner wrote it. */
  acceptanceCriteria: string[];
  startedAt: string | null;
  endedAt: string | null;
  commits: TaskCommit[];
}

/** A question the planner stopped to ask. One at a time. */
export interface PlannerQuestion {
  id: string;
  text: string;
  askedAt: string;
  /** The task it came from, when it came from one. */
  taskId: string | null;
}

export interface Swarm {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  goal: string;
  status: SwarmStatus;
  /** Why a paused swarm is paused, so the header prints the right sentence. */
  pausedReason: "manual" | "budget" | "time_limit" | "attention" | "plan_limit" | "error" | null;
  /** The single branch every leaf lands onto. */
  branchName: string | null;
  deliverable: "code" | "document";
  templateId: string | null;
  /** The cap. Null means this swarm has none. */
  budgetUsd: number | null;
  maxWorkers: number;
  /** Workers the swarm is allowed to run at once, as the stepper reads it. */
  workers: number;
  /** Workers actually holding a leaf right now. */
  workersActive: number;
  timeLimitMin: number | null;
  spend: SwarmSpend;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  archivedAt: string | null;
  lastOpenedAt: string | null;
  question: PlannerQuestion | null;
}

/** A row of the strip. The list endpoint sends no tree. */
export interface SwarmSummary {
  id: string;
  projectId: string;
  name: string;
  status: SwarmStatus;
  createdAt: string;
  archivedAt: string | null;
  lastOpenedAt: string | null;
  /**
   * The root ring, 0 to 1, rolled up by the server for swarms whose
   * tree this browser has not loaded. The open swarm's tab uses the
   * number the page computed instead, so the tab and the header can
   * never disagree.
   */
  completion: number;
}

/** One leaf's branch waiting its turn on the merge queue. */
export interface SwarmLanding {
  id: string;
  taskId: string;
  branchName: string | null;
  position: number;
  status: "queued" | "landing" | "landed" | "conflict" | "failed";
  attempt: number;
  error: string | null;
}

/**
 * One charge, with the confidence it was recorded at. The header's
 * three figures are this list grouped by tier.
 */
export interface SwarmLedgerEntry {
  id: string;
  at: string;
  taskId: string | null;
  /** The tool or model the charge is for. */
  source: string;
  tier: SpendTier;
  usd: number;
}

export type SpendTier = "measured" | "estimated" | "assumed";

export interface SwarmPullRequest {
  id: string;
  repoUrl: string;
  number: number;
  url: string;
  headSha: string | null;
}

export interface SwarmDetail {
  swarm: Swarm;
  tasks: SwarmTask[];
  landings: SwarmLanding[];
  ledger: SwarmLedgerEntry[];
  pullRequests: SwarmPullRequest[];
}

/**
 * A template, and the cost shape the dialog prints beside it.
 *
 * `tools` is what makes the shape honest: a tool that reports its own
 * spend lands in the measured tier, one that prints tokens lands in
 * estimated, and one that prints nothing lands in assumed. The number
 * a person sees before they press Create is the sum of what a run
 * would cost, split the same three ways it will be reported in.
 */
export interface SwarmTemplate {
  id: string;
  name: string;
  description: string;
  plannerModel: string;
  workerModel: string;
  tools: { name: string; tier: SpendTier }[];
  /** Per worker leaf, for the tools that report nothing. */
  assumedUsdPerLeaf: number;
  /** What the template expects a leaf to cost, by tier. */
  perLeaf: SwarmSpend;
  maxWorkers: number;
  maxBudgetUsd: number | null;
  timeLimitMin: number | null;
  /** Leaves this template's planner typically produces, for the estimate. */
  typicalLeaves: number;
}

/** What the New swarm dialog sends. */
export interface NewSwarmInput {
  projectId: string;
  templateId: string;
  name: string;
  goal: string;
  attachments: { name: string; bytes: number }[];
  start: { kind: "new-branch"; name: string } | { kind: "existing-branch"; name: string };
  deliverable: "code" | "document";
  budgetUsd: number | null;
  workers: number;
  /** Plan only stops after the planner, before any worker starts. */
  planOnly: boolean;
}
