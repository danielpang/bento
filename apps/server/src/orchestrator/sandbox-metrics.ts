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
