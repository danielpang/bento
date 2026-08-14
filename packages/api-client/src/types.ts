import type { AgentCli, FeatureStatus, GateCriteria, RunStatus } from "@bento/core";

export interface Project {
  id: string;
  name: string;
  repoUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
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
}

export interface AgentRun {
  id: string;
  /** Present when the sandbox was snapshotted before this run. */
  checkpointId?: string | null;
  featureId: string;
  stageId: string;
  agentProfileId: string;
  status: RunStatus;
  cliSessionId: string | null;
  costUsd: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
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

export interface FeatureEvent {
  id: string;
  kind: "stage_moved" | "status_changed";
  fromStageId: string | null;
  toStageId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  trigger: string;
  actorUserId: string | null;
  runId: string | null;
  detail: { failedCriteria?: string[] } | null;
  at: string;
}
