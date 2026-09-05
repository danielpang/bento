import type { AgentCli, FeatureStatus, GateCriteria, RunStatus } from "@bento/core";

export interface Project {
  id: string;
  name: string;
  repoUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  /** Whether an issue arriving from Linear starts this project's pipeline. */
  autoStartPipeline: boolean;
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
   * "judge" is the gate evaluator talking to itself; "rebase" is a
   * resolve-conflicts run. Omitted on older payloads and treated as
   * work. Spend rollups skip judges.
   */
  kind?: "task" | "judge" | "rebase";
  cliSessionId: string | null;
  costUsd: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
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
  /** Whether this user is on the permanent beta-testers allowlist. */
  betaTesters: boolean;
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
