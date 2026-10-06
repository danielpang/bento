import type { Analytics } from "../analytics.js";

/**
 * A sandbox was provisioned for a run.
 *
 * One event per machine made, so a count by `provider` says how many
 * runs landed on a Fly sprite and how many on a Modal sandbox, and a
 * count where `fell_back_from` is set says how often Fly could not
 * provide one. `selection` is why that provider was chosen: the
 * project's "auto" order, a provider the project named, the
 * deployment default, or a machine the card already had.
 */
export const SANDBOX_PROVISIONED_EVENT = "sandbox provisioned";

export type SandboxSelection = "auto" | "project" | "default" | "existing";

export interface SandboxProvisioned {
  /** The provider that made the machine. */
  provider: string;
  selection: SandboxSelection;
  /** The provider that failed first, when the "auto" order moved on. */
  fellBackFrom: string | null;
  /** How many drivers were asked before one answered. */
  attempts: number;
  projectId: string;
  organizationId: string | null;
  /** The person who started the run, when there is one. */
  userId: string | null;
  featureId?: string;
  swarmId?: string;
  swarmTaskId?: string | null;
}

export function reportSandboxProvisioned(analytics: Analytics | null | undefined, info: SandboxProvisioned): void {
  try {
    analytics?.capture({
      event: SANDBOX_PROVISIONED_EVENT,
      userId: info.userId,
      organizationId: info.organizationId,
      properties: {
        provider: info.provider,
        selection: info.selection,
        fell_back_from: info.fellBackFrom,
        fell_back: info.fellBackFrom !== null,
        attempts: info.attempts,
        project_id: info.projectId,
        ...(info.featureId ? { feature_id: info.featureId } : {}),
        ...(info.swarmId ? { swarm_id: info.swarmId } : {}),
        ...(info.swarmTaskId ? { swarm_task_id: info.swarmTaskId } : {}),
      },
    });
  } catch (err) {
    console.warn(`could not record a sandbox provision on ${info.provider}:`, err);
  }
}

/**
 * A run's sandbox was provisioned and its agent is being started.
 *
 * One event per run that reached its agent, timed from the moment the
 * card entered the stage (the run's `queued_at`, written in the same
 * transaction as the move) to the moment the agent CLI is spawned in
 * the machine. That is the wait a person sees between dropping a card
 * on a stage and the agent's first word, less the model's first turn.
 *
 * `duration_ms` is that whole wait. Two slices say where it went:
 * `queue_wait_ms` is the run sitting in the queue before a worker
 * claimed it, and `provision_ms` is the sandbox driver alone (machine
 * creation, tool install, clones). The rest is setup commands, the
 * snapshot, and the MCP attach.
 *
 * `sandbox_origin` says whether the machine was made from scratch
 * (`new`: a card's first stage, or a card whose machine was reaped)
 * or an existing one was reopened (`reused`: every stage after the
 * first, which finds the card's sandbox row and keeps its machine).
 * A reopened machine is expected to be seconds; a new one is minutes.
 */
export const SANDBOX_READY_EVENT = "sandbox ready";

export type SandboxOrigin = "new" | "reused";

export interface SandboxReady {
  runId: string;
  provider: string;
  selection: SandboxSelection;
  /** When the card entered the stage: the run's `queued_at`. */
  queuedAt: Date;
  /** When a worker claimed the run: the run's `started_at`. */
  claimedAt: Date;
  /** When the agent was spawned in the sandbox. */
  agentStartedAt: Date;
  /** How long `provisionWorkspace` alone took, in milliseconds. */
  provisionMs: number;
  projectId: string;
  organizationId: string | null;
  /** The person who started the run, when there is one. */
  userId: string | null;
  featureId?: string;
  stageId?: string;
  swarmId?: string;
  swarmTaskId?: string | null;
}

/** Why a machine was reopened rather than made: the card already had a sandbox row. */
export function sandboxOrigin(selection: SandboxSelection): SandboxOrigin {
  return selection === "existing" ? "reused" : "new";
}

export function reportSandboxReady(analytics: Analytics | null | undefined, info: SandboxReady): void {
  try {
    const origin = sandboxOrigin(info.selection);
    analytics?.capture({
      event: SANDBOX_READY_EVENT,
      userId: info.userId,
      organizationId: info.organizationId,
      properties: {
        duration_ms: Math.max(0, info.agentStartedAt.getTime() - info.queuedAt.getTime()),
        queue_wait_ms: Math.max(0, info.claimedAt.getTime() - info.queuedAt.getTime()),
        provision_ms: Math.max(0, Math.round(info.provisionMs)),
        sandbox_origin: origin,
        sandbox_reused: origin === "reused",
        provider: info.provider,
        selection: info.selection,
        run_id: info.runId,
        project_id: info.projectId,
        ...(info.featureId ? { feature_id: info.featureId } : {}),
        ...(info.stageId ? { stage_id: info.stageId } : {}),
        ...(info.swarmId ? { swarm_id: info.swarmId } : {}),
        ...(info.swarmTaskId ? { swarm_task_id: info.swarmTaskId } : {}),
      },
    });
  } catch (err) {
    console.warn(`could not record the sandbox wait for run ${info.runId}:`, err);
  }
}
