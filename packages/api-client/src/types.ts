import type { AgentCli, FeatureStatus, GateCriteria, RunStatus, SandboxProvider, SwarmAccessState } from "@bento/core";

export interface Project {
  id: string;
  name: string;
  repoUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  /** Whether an issue arriving from Linear starts this project's pipeline. */
  autoStartPipeline: boolean;
  /**
   * Where new cards run. Always "auto" (a Fly sprite, then Modal, on
   * a hosted deployment): nothing in the product sets anything else,
   * and the row carries it only because the column does.
   */
  sandboxProvider: SandboxProvider | null;
  /** Whether a card created in this project files an issue in Linear. */
  linearCreateIssues: boolean;
  /**
   * Where those issues go when no Linear team is mapped to this project.
   * The key and name are kept so settings can name the team without
   * calling Linear.
   */
  linearTeamId: string | null;
  linearTeamKey: string | null;
  linearTeamName: string | null;
  linearProjectId: string | null;
  linearProjectName: string | null;
}

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  localPath: string;
  repoUrl: string | null;
  githubRepoId: string | null;
  defaultBranch: string;
  /** Shell run once in a fresh sandbox: the project's own toolchain. */
  setupCommand: string | null;
  /** Shell the agent is told to run to prove its work. */
  testCommand: string | null;
}

/**
 * One pull request a card has open. A card spanning a frontend and a
 * backend has one in each, and is only finished when both are.
 */
export interface FeaturePullRequest {
  /** The repository it was opened in, by the name the project uses. */
  name: string;
  number: number;
  url: string;
}

/**
 * One pull request the card has opened, live or landed.
 *
 * A card keeps every pull request it has opened: when one merges, the
 * next message starts a new branch and opens another, so `current`
 * says which belong to the branch the card is on now.
 */
export interface FeaturePullRequestRecord extends FeaturePullRequest {
  branch: string;
  current: boolean;
}

/**
 * How one of the card's pull requests ended. "closed" is one closed
 * without merging, whose work never shipped; "unknown" covers every
 * unreadable case, including a card with no GitHub connection.
 */
export interface FeaturePullRequestStatus {
  number: number;
  url: string;
  state: "merged" | "open" | "closed" | "unknown";
}

/**
 * Where one of the card's pull requests stands against its base branch.
 * "unknown" covers every unreadable case (no GitHub connection, GitHub
 * still computing, a closed pull request) and is treated as "not known
 * to conflict"; only "conflicted" asks for anything.
 */
export interface FeatureMergeStatus {
  name: string;
  number: number;
  url: string;
  state: "clean" | "conflicted" | "unknown";
}

/**
 * How CI checks on one pull request head are doing. Only "failed" asks
 * for anything in the drawer; "pending" and "unknown" stay silent.
 */
export interface FeatureCheckStatus {
  name: string;
  number: number;
  url: string;
  state: "passed" | "pending" | "failed" | "unknown";
}

/**
 * A coding agent, and whether this deployment can run it. `installed`
 * is null when the question could not be answered (no sandbox image
 * built, no daemon), which must not be shown as "missing".
 */
export interface AgentTool {
  cli: string;
  label: string;
  binary: string;
  installed: boolean | null;
  installUrl: string;
  installCommand: string;
}

export interface Stage {
  id: string;
  pipelineId: string;
  position: number;
  name: string;
  slug: string;
  description: string;
  defaultAgentProfileId: string | null;
  gateType: "manual" | "auto";
  gateCriteria: GateCriteria;
  /** Push the branch and open the pull request when a run here succeeds. */
  createPr: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: FeatureStatus;
  currentStageId: string | null;
  branchName: string | null;
  prNumber: number | null;
  /** The first pull request's address, so the number can be reached. */
  prUrl?: string | null;
  /**
   * The card this one was split out of, when it was. Null on nearly
   * every card: it is only set when an agent, or a person, judged a
   * task too large for one branch and filed its parts separately.
   */
  parentId?: string | null;
}

/** One card as the related-cards view draws it. */
export interface RelatedCard {
  id: string;
  title: string;
  status: FeatureStatus;
  currentStageId: string | null;
  stageName: string | null;
  runStatus: string | null;
  costUsd: number | null;
  prNumber: number | null;
  prUrl: string | null;
}

/**
 * A card that was split, and every card that split produced. Null for
 * a card that is neither, which is most of them.
 */
export interface RelatedGroup {
  parent: RelatedCard;
  children: RelatedCard[];
  /**
   * The card this group’s parent was itself split from, when it was.
   * Present only on a mid-level parent, so the drawer can show both
   * "Parts" and "Part of" instead of picking one.
   */
  partOf?: RelatedCard | null;
}

export interface AgentRun {
  id: string;
  /** Present when the sandbox was snapshotted before this run. */
  checkpointId?: string | null;
  featureId: string;
  stageId: string;
  agentProfileId: string;
  status: RunStatus;
  /**
   * What this run is. "stage" is a card being walked through a stage,
   * "judge" is the gate evaluator talking to itself, and "rebase" is a
   * resolve-conflicts run. Omitted on older payloads and treated as
   * work. Spend rollups skip judges.
   */
  role?: "stage" | "judge" | "rebase";
  cliSessionId: string | null;
  costUsd: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * The sandbox provider that ran this run ("sprite", "modal",
   * "docker", "local-process", or what a runner reported). Null until
   * the run provisions, when provisioning failed, and on older runs.
   */
  sandboxProvider?: string | null;
  /**
   * Whether the run's agent was started as a live session, so a message
   * reaches it mid-run. Null until the agent starts, and on older runs.
   */
  liveSession?: boolean | null;
}

/** One multiple choice question an agent put to a person. */
export interface AskedQuestion {
  question: string;
  /** A short label for the question. */
  header?: string;
  /** Whether more than one option may be chosen. */
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** Questions the agent is blocked on until a person answers them. */
export interface RunQuestion {
  id: string;
  runId: string;
  questions: AskedQuestion[];
  createdAt: string;
}

/** A person's answer to one question: options picked, and free text beside or instead of them. */
export interface QuestionChoice {
  question: string;
  selected: string[];
  other?: string;
}

/**
 * Agent spend for one project. Cost is whatever the CLI printed;
 * `runsWithoutCost` is how many runs that figure silently omitted.
 * Totals cover finished work only, never judges or in-flight runs.
 */
export interface ProjectUsage {
  totalUsd: number;
  totalRuns: number;
  runsWithoutCost: number;
  byStage: {
    stageId: string;
    agentProfileId: string;
    runs: number;
    costUsd: number;
  }[];
  /** Every card, including ones that have never run. */
  byFeature: FeatureSpend[];
  /**
   * Every swarm, as a swarm.
   *
   * A swarm's runs belong to no card, so they are absent from
   * `byFeature` entirely: without this a swarm that cost forty dollars
   * would be nowhere on the page. Optional, because a server older
   * than swarms does not send it.
   */
  bySwarm?: SwarmSpendRow[];
}

/**
 * One swarm's spend, split the way it is recorded.
 *
 * Measured is what tools printed, estimated is priced from reported
 * tokens, and notional is a subscription list price. The assumed field
 * remains for wire compatibility and is zero for current data.
 */
export interface SwarmSpendRow {
  swarmId: string;
  title: string;
  status: string;
  runs: number;
  runsWithoutCost: number;
  measuredUsd: number;
  estimatedUsd: number;
  assumedUsd: number;
  notionalUsd: number;
}

/**
 * One card's contribution to project spend. `costUsd` is null when no
 * run on the card reported a figure, which is not the same as zero.
 */
export interface FeatureSpend {
  featureId: string;
  title: string;
  runs: number;
  costUsd: number | null;
  runsWithoutCost: number;
}

/** The windows the completions chart can be asked for. */
export type CompletionRange = "1d" | "1w" | "1m" | "3m" | "6m" | "1y";

/**
 * Cards completed over one window, bucketed server-side. A card counts
 * once, at its latest completion, and only while it is still done.
 * Buckets are contiguous and zero-filled, oldest first; `start` is the
 * bucket's opening instant in UTC.
 */
export interface ProjectCompletions {
  range: CompletionRange;
  bucketUnit: "hour" | "day" | "week" | "month";
  total: number;
  buckets: { start: string; completed: number }[];
}

/** The preset windows the Analytics page offers; a custom window names two dates instead. */
export type AnalyticsRange = "3d" | "1w" | "2w" | "1m";

/** How the Analytics window is cut into bars. */
export type AnalyticsBucketUnit = "6h" | "day" | "week" | "month";

/** What to ask the Analytics route for: a preset, or two UTC dates (the last one included). */
export type AnalyticsQuery = { range: AnalyticsRange } | { from: string; to: string };

/** The headline figures for one window. Every count is of what happened inside the window. */
export interface AnalyticsTotals {
  cardsCreated: number;
  /** Done cards, each at its latest completion, and only while still done. */
  cardsCompleted: number;
  stageMoves: number;
  /** Moves a person made from the board. */
  stageMovesByHand: number;
  /** Moves a gate, an agent, Linear or the system made. */
  stageMovesAutomatic: number;
  /** Finished runs: cards and swarms, judges left out, the usage rule. */
  runs: number;
  runsSucceeded: number;
  runsFailed: number;
  runsCancelled: number;
  /** The sum of what those runs reported; `runsWithoutCost` of them reported nothing. */
  spendUsd: number;
  runsWithoutCost: number;
}

/**
 * The Analytics page for one project and one window. The buckets are
 * the window cut on UTC boundaries, oldest first and zero-filled, so
 * the first and last may be partial; their sums are the totals.
 */
export interface ProjectAnalytics {
  window: { range: AnalyticsRange | "custom"; from: string; to: string; bucketUnit: AnalyticsBucketUnit };
  totals: AnalyticsTotals;
  /** The window of the same length that ended where this one starts. */
  previous: AnalyticsTotals;
  buckets: { start: string; completed: number; created: number; stageMoves: number; runs: number }[];
  /** The pipeline's stages in order, then Done with a null id. */
  byStage: { stageId: string | null; name: string; position: number; movesIn: number; cardsNow: number }[];
  /** Cards with a run or a stage move in the window, spend measured over the window. */
  byFeature: (FeatureSpend & { stageMoves: number })[];
  /** Swarms with a run in the window, with the measured cost of those runs. */
  bySwarm: { swarmId: string; title: string; status: string; runs: number; runsWithoutCost: number; costUsd: number }[];
}

/**
 * One conversation on the sessions page: a card and its run history,
 * summarized by the newest run. Judge runs are not counted.
 */
export interface ProjectSession {
  featureId: string;
  title: string;
  runCount: number;
  /** Null when no run on the card reported a cost, which is not zero. */
  totalCostUsd: number | null;
  latestRun: Pick<
    AgentRun,
    "id" | "status" | "agentProfileId" | "queuedAt" | "startedAt" | "endedAt" | "costUsd"
  >;
}

export interface AgentProfile {
  /** User-authored operating instructions, injected into stage prompts. */
  skill?: string | null;
  extraArgs?: string[];
  id: string;
  name: string;
  cli: AgentCli;
  model: string;
}

export interface GateCheck {
  id: string;
  criterion: { type: string; cmd?: string };
  status: "pending" | "passed" | "failed";
  detail: { message?: string } | null;
}

export interface GateState {
  status: FeatureStatus;
  currentStageId: string | null;
  checks: GateCheck[];
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface StageArtifact {
  path: string;
  content: string;
}

export interface RepositoryChanges {
  name: string;
  branch: string;
  files: ChangedFile[];
  diff: string;
  truncated: boolean;
  artifacts: StageArtifact[];
}

/** What the card's agents have committed so far, per repository. */
export interface FeatureChanges {
  branch: string | null;
  repositories: RepositoryChanges[];
}

export type RunArtifactKind = "markdown" | "mermaid" | "image" | "html" | "file";

/**
 * One file an agent produced for people, captured from the sandbox when
 * its run ended: the stage write-up, a mockup, a screenshot, a diagram.
 * Metadata only; the body is fetched per artifact when opened.
 */
export interface RunArtifact {
  id: string;
  runId: string;
  stageSlug: string;
  stageName: string;
  /** Where the agent wrote it, relative to the workspace. */
  path: string;
  kind: RunArtifactKind;
  mime: string;
  size: number;
  createdAt: string;
}

export interface FlagSnapshot {
  /** Whether this user has beta features on, for the team they have open. */
  betaTesters: boolean;
  /**
   * The switch behind it on a hosted server: the person's own choice, and
   * whether their open team allows beta. Absent in local mode, where the
   * desktop app's startup flag decides.
   */
  betaFeatures?: { enabled: boolean; allowed: boolean };
  /**
   * Whether the Swarms tab opens the board or the waitlist. Always
   * "open" in local mode. Absent from a server that predates it.
   */
  swarms?: SwarmAccessState;
  /** On the waitlist only: whether this person already asked to join it. */
  swarmWaitlistJoined?: boolean;
}

export interface FeatureEvent {
  id: string;
  kind: "stage_moved" | "status_changed";
  fromStageId: string | null;
  toStageId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  trigger: string;
  actorUserId: string | null;
  /** Present when a person moved the card and their account still exists. */
  actorName: string | null;
  actorEmail: string | null;
  runId: string | null;
  detail: { failedCriteria?: string[] } | null;
  at: string;
}

/**
 * A swarm, as the API sends one.
 *
 * The table's own names, because the swarm routes answer with their
 * rows and a second vocabulary between the server and a terminal is
 * one more place for the two to disagree. Numerics arrive as strings,
 * which is what Postgres numeric is: a figure nobody has rounded.
 */
export interface SwarmRow {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  goal: string;
  status:
    | "draft"
    | "planning"
    | "running"
    | "paused"
    | "blocked"
    | "done"
    | "failed"
    | "cancelled"
    | "budget_exhausted"
    | "timed_out";
  pausedReason: "manual" | "budget" | "time_limit" | "attention" | "plan_limit" | "error" | "usage_limit" | null;
  pausedUntil?: string | null;
  branchName: string | null;
  deliverable?: "code" | "document";
  startBranch?: string | null;
  reopenCount?: number;
  /** Where the plan came from: the planner wrote it, or a person handed one over. */
  planMode?: "goal" | "existing";
  budgetUsd: string | null;
  maxWorkers: number;
  timeLimitMin: number | null;
  spentMeasuredUsd: string;
  spentEstimatedUsd: string;
  spentAssumedUsd: string;
  spentNotionalUsd?: string;
  archivedAt: string | null;
  createdAt: string;
}

/** A row of the swarm list, with the counts the strip draws. */
export interface SwarmSummaryRow extends SwarmRow {
  counts: { tasks: number; done: number; attention: number };
}

/** One node of a swarm's plan. The tree travels flat, each naming its parent. */
export interface SwarmTaskRow {
  id: string;
  parentId: string | null;
  position: number;
  nodeType: "plan" | "leaf";
  title: string;
  description: string;
  status: "open" | "assigned" | "working" | "landed" | "done" | "blocked" | "failed" | "cancelled";
  attention: string | null;
  weight: number;
  branchName: string | null;
  /** What a reopen asked for, on the node that holds its work. */
  followUpInstruction?: string | null;
  costMeasuredUsd: string;
  costEstimatedUsd: string;
  costAssumedUsd: string;
  costNotionalUsd?: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Where a reported leaf's review stands. Absent from an older server. */
  review?: SwarmLeafReview | null;
}

/** Where a reported leaf stands with the planner. */
export type SwarmLeafReview = "waiting" | "reviewing" | "restarting" | "stopped" | "undecided";

/** One source of the plan a person handed a swarm, without its text. */
export interface SwarmPlanSourceRow {
  id: string;
  position: number;
  kind: "file" | "website";
  name: string;
  url: string | null;
  mime: string;
  /** What it is read as: text, a PDF, or an image. */
  media: "text" | "pdf" | "image";
  /** Characters of text. Zero for an image or a scanned PDF. */
  size: number;
  hasText: boolean;
  /** Bytes in the store, for a PDF or an image. */
  byteSize: number | null;
}

/** One swarm with its plan, as the detail route answers. */
export interface SwarmDetailResponse {
  /** All planner runs, oldest first, for one continuous conversation. */
  plannerRuns?: { id: string; queuedAt: string; endedAt: string | null }[];
  swarm: SwarmRow;
  tasks: SwarmTaskRow[];
  /** What the person handed the planner, when they handed over anything. */
  planSources?: SwarmPlanSourceRow[];
  activeRuns: { id: string; role: string | null; status: string; swarmTaskId: string | null }[];
  landings?: {
    id: string;
    taskId: string;
    branchName: string | null;
    status: "queued" | "landing" | "landed" | "conflicted" | "failed" | "cancelled";
    attempt: number;
    error: string | null;
  }[];
  pullRequests?: { id: string; repoUrl: string; number: number; url: string; headSha: string | null }[];
}
