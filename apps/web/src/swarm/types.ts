/**
 * What the swarm endpoints answer with.
 *
 * This is the shape the console draws from. The names are mostly the
 * table's, because the swarm routes answer with their rows: `nodeType`
 * here is `swarm_tasks.node_type` there, and one vocabulary end to end
 * is what keeps the console reading what the server sends. Where the
 * two differ (a swarm's name, its status words, a leaf's attention)
 * `client.ts` is the one place that translates, and the fixtures speak
 * this shape so the tests can drive the console without a server.
 *
 * Two endpoints fill it:
 *
 *   GET /api/swarms?projectId=  ->  SwarmSummary[]   (the strip)
 *   GET /api/swarms/:id         ->  SwarmDetail      (the page)
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
  | "timed_out"
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
 * Whether this node wants a person, and what about.
 *
 * A second axis and not a status: a worker that has been going for an
 * hour is still `working`, and a leaf holding a question is still
 * whatever it was doing.
 *
 * The reasons are the server's own words, carried through rather than
 * flattened. They were flattened once, to "escalated", and the board
 * then told everybody that four different things all needed them
 * equally: a planner's question, a merge conflict, a failed worker and
 * a swarm that had run out of money read identically, and none of them
 * said what to do. The colour is still one colour. The sentence is not.
 */
export type TaskAttention =
  | "none"
  | "long_running"
  | "escalated"
  | "question"
  | "failed"
  | "conflict"
  | "budget"
  | "plan_limit";

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
  /**
   * A printed price that a subscription had already paid for.
   *
   * The fourth figure, and the one the budget does not count. A local
   * install can lend a run the operator's own logged in agent session;
   * the tool still prints its list price, but the work was already
   * paid for and the marginal cost of the run is zero. Counting it
   * would stop a swarm that is costing nothing.
   */
  notionalUsd: number;
}

/**
 * A commit made for one node, found by its `Bento-Task` trailer.
 *
 * Read out of git rather than stored: landing rebases a worker's
 * commits onto the swarm's branch and every sha changes, so a list
 * recorded when the work was done would name commits no branch has.
 * `repository` is which of the project's repositories it is in, which
 * matters as soon as a project spans more than one.
 */
export interface TaskCommit {
  sha: string;
  message: string;
  at: string;
  repository?: string;
}

/**
 * Something that happened to one node.
 *
 * `kind` is the server's own word (created, assigned, status_changed,
 * attention_raised, landed, note), and `runId` is what makes a
 * resolver visible: it is the only record on the node itself that an
 * agent other than its worker was ever put on it.
 *
 * `detail` is loosely typed on purpose. It is coordinator bookkeeping
 * and agent written, so it is rendered as text the way a flag's value
 * is, never interpreted.
 */
export interface SwarmTaskEvent {
  id: string;
  kind: string;
  at: string;
  fromStatus: string | null;
  toStatus: string | null;
  runId: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * What the drawer asks for when a node is opened.
 *
 * Its own request rather than fields on the plan: the commits are read
 * by grepping a branch per repository, which is a git process per node
 * per repository, and nobody is looking at them until a node is open.
 *
 *   GET /api/swarms/:id/tasks/:taskId  ->  SwarmNodeDetail
 */
export interface SwarmNodeDetail {
  taskId: string;
  commits: TaskCommit[];
  events: SwarmTaskEvent[];
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
  /**
   * The agent a person chose for this leaf, or null for the template's
   * own worker. What the drawer's Reassign writes, and what the next
   * spawn on this leaf reads.
   */
  agentProfileId: string | null;
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
  /**
   * The server's own words, not a translation of them. The panel picks
   * the label; a second vocabulary here was how "conflict" and
   * "conflicted" came to mean the same thing in two files, and a row
   * whose status matched neither drew as nothing at all.
   */
  status: "queued" | "landing" | "landed" | "conflicted" | "failed" | "cancelled";
  attempt: number;
  error: string | null;
  /** The agent reconciling this branch, when one was started. */
  resolverRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
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

export type SpendTier = "measured" | "estimated" | "assumed" | "notional";

export interface SwarmPullRequest {
  id: string;
  repoUrl: string;
  number: number;
  /**
   * Where to send somebody who clicks it, or null.
   *
   * Null is not "no pull request": it is a url the console refused to
   * link to. The row is written on a path agents are on, and an
   * `href` is not inert, so `client.ts` runs what the server sent
   * through `externalHttpUrl` and anything that is not an http address
   * arrives here as null. The chip then draws as text.
   */
  url: string | null;
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
  /**
   * Where this template's agents work: a machine each, holding its own
   * clone, or worktrees of the repository already on the server.
   *
   * Recorded on the template rather than read off the deployment, so a
   * swarm made on a local install keeps its shape if that install
   * later joins a team, and is refused rather than quietly reshaped if
   * the deployment cannot run it that way.
   */
  workerIsolation: "sandbox" | "worktree";
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
