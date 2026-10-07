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
  owner: SandboxOwner;
}

/** The rows a machine belongs to, as the metrics name them. */
export type SandboxOwner = { featureId: string } | { swarmId: string; swarmTaskId?: string | null };

/**
 * One rule for naming a run's board in an event: a card names its
 * feature (and its stage when the caller knows it), a swarm names
 * the swarm and the task when the machine is a worker's. Every event
 * about a sandbox and the exception it records go through here, so
 * no two of them spell the same run differently.
 */
export function runOwnerProperties(owner: SandboxOwner, stageId?: string): Record<string, string> {
  if ("featureId" in owner) {
    return { feature_id: owner.featureId, ...(stageId ? { stage_id: stageId } : {}) };
  }
  return { swarm_id: owner.swarmId, ...(owner.swarmTaskId ? { swarm_task_id: owner.swarmTaskId } : {}) };
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
        ...runOwnerProperties(info.owner),
      },
    });
  } catch (err) {
    console.warn(`could not record a sandbox provision on ${info.provider}:`, err);
  }
}

/**
 * A run's sandbox was provisioned and its agent has come up in it.
 *
 * One event per run whose agent started, timed from the moment the
 * run was queued to the agent's first word. For a stage with an
 * assigned agent the run is queued in the same transaction as the
 * card's move into the stage, so that is the wait a person sees
 * between dropping the card and the agent working, less the model's
 * first turn. A run started by hand, a judge, a rebase, or a stage
 * entered while the previous run was still working is timed from
 * when its run was queued instead; `role` tells them apart.
 *
 * `duration_ms` is that whole wait. Two slices say where it went:
 * `queue_wait_ms` is the run sitting in the queue before a worker
 * claimed it, and `provision_ms` is the sandbox driver alone
 * (machine creation, tool install, clones). The rest is setup
 * commands, the snapshot, and the MCP attach.
 *
 * Every term is on one clock. The queue wait is computed by the
 * database when the run is claimed, from its own `queued_at` and its
 * own `now()`, and the rest is a monotonic interval measured by the
 * process that claimed the run. Nothing subtracts a database
 * timestamp from an application one, so clock skew between the two
 * hosts never lands in the number.
 *
 * `sandbox_origin` says what the machine was: `new` when the card
 * had none and one was made (its first stage, or after its machine
 * was reaped), `reused` when a machine already running was reopened
 * (every stage after the first, which keeps the card's sandbox
 * row), and `restored` when the card had a machine that was not
 * running and one was made again for it (a hibernated Modal
 * snapshot, or a sprite that disappeared outside Bento). A reused
 * machine is expected to take seconds; the other two take minutes.
 * The driver's own answer, `createdSandbox`, decides; a driver with
 * no machine to speak of leaves it absent, and the owner's own
 * sandbox row stands in.
 *
 * Only runs the server executes report it. A run on a runner
 * executor reports through the runner route with what the runner
 * told it, and `provision_ms` is absent when it told it nothing.
 */
export const SANDBOX_READY_EVENT = "sandbox ready";

export type SandboxOrigin = "new" | "reused" | "restored";

/**
 * What a provision did, from what the driver said and what the rows
 * said. `createdSandbox` is the driver's own answer and wins when it
 * gave one; `hadMachine` is whether this owner (the card, or the
 * swarm task) already had a live sandbox row of its own, which is
 * the fallback for a driver that gave no answer and what turns "made
 * a machine for an owner that had one" into `restored`. The owner's
 * own row, not the driver selection: a swarm worker follows the
 * planner's row to a provider, and its first machine is still new.
 */
export function sandboxOrigin(input: { createdSandbox?: boolean | undefined; hadMachine?: boolean | undefined }): SandboxOrigin {
  const hadMachine = input.hadMachine === true;
  if (input.createdSandbox === undefined) return hadMachine ? "reused" : "new";
  if (!input.createdSandbox) return "reused";
  return hadMachine ? "restored" : "new";
}

export interface SandboxReady {
  runId: string;
  /** The run's role: stage, judge, rebase, or a swarm role. */
  role: string;
  provider: string;
  selection?: SandboxSelection;
  origin: SandboxOrigin;
  /** From the run being queued to a worker claiming it, by the database's clock. */
  queueWaitMs: number;
  /** From the claim to the agent coming up, measured monotonically by the claiming process. */
  sinceClaimMs: number;
  /** How long the sandbox driver alone took, when known. */
  provisionMs?: number;
  projectId: string;
  organizationId: string | null;
  /** The person who started the run, when there is one. */
  userId: string | null;
  owner: SandboxOwner;
  stageId?: string;
}

/** A duration as PostHog gets it: whole milliseconds, never negative. */
function wholeMs(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export function reportSandboxReady(analytics: Analytics | null | undefined, info: SandboxReady): void {
  try {
    const queueWait = wholeMs(info.queueWaitMs);
    const sinceClaim = wholeMs(info.sinceClaimMs);
    analytics?.capture({
      event: SANDBOX_READY_EVENT,
      userId: info.userId,
      organizationId: info.organizationId,
      properties: {
        duration_ms: queueWait + sinceClaim,
        queue_wait_ms: queueWait,
        ...(info.provisionMs !== undefined ? { provision_ms: wholeMs(info.provisionMs) } : {}),
        sandbox_origin: info.origin,
        provider: info.provider,
        ...(info.selection ? { selection: info.selection } : {}),
        role: info.role,
        run_id: info.runId,
        project_id: info.projectId,
        ...runOwnerProperties(info.owner, info.stageId),
      },
    });
  } catch (err) {
    console.warn(`could not record the sandbox wait for run ${info.runId}:`, err);
  }
}
