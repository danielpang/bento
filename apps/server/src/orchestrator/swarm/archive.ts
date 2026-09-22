import { and, eq, ne } from "drizzle-orm";
import { sandboxes, swarms, type Db } from "@bento/db";
import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";

/**
 * Putting a swarm away, and taking it out again.
 *
 * Both halves are about a machine nobody is working in. A swarm holds
 * one of its own (the planner's, and the merge queue's), and on a
 * hosted deployment that is a sprite billed by the gigabyte month for
 * as long as it exists, whether or not anything ever wakes it again.
 *
 * **Pausing checkpoints it.** A paused swarm is one somebody means to
 * come back to, so the machine stays; what changes is that the driver
 * is asked for a snapshot first, and the id goes on the row. Resuming
 * then starts from where it stopped rather than from a fresh clone,
 * which is the difference between a resume and a ten minute install.
 * A driver that cannot snapshot is not a failure: its containers hold
 * nothing the repository on the host does not already have.
 *
 * **Archiving reaps it.** Putting a swarm away is a person saying they
 * are finished with it, and a machine kept for a swarm nobody will
 * open again is pure cost. Its rows stay: what the swarm did and what
 * it spent is still readable, and restoring it provisions a new
 * machine on the next run, the same way the first one appeared.
 *
 * Neither is done inline in the request. The provider is a network
 * call away, and pausing a swarm must not fail because Fly was slow.
 */

/** Anything that can read and write the rows here. */
export type ArchiveWriter = Pick<Db, "select" | "update">;

/** What one checkpoint did, for the log and the tests. */
export interface CheckpointResult {
  /** Sandboxes that were snapshotted, with the id each was given. */
  checkpointed: { sandboxId: string; checkpointId: string }[];
  /** Why nothing was taken, when nothing was. */
  skipped: string | null;
}

/** The machines a swarm holds that are still there. */
export async function liveSwarmSandboxes(
  db: ArchiveWriter,
  swarmId: string,
): Promise<(typeof sandboxes.$inferSelect)[]> {
  return db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.swarmId, swarmId), ne(sandboxes.status, "destroyed")));
}

/**
 * Snapshots the machines a paused swarm holds.
 *
 * Every one of them, not just the swarm's own: a worker's machine is
 * mid task when a person pauses (nothing is killed for a pause, but a
 * leaf that has not started yet will not start), and it is the one
 * holding a half finished branch.
 *
 * A snapshot that fails is logged and skipped rather than thrown. The
 * pause has already happened by the time this runs, and a swarm that
 * refused to pause because a provider was slow would be the worst of
 * both: still running, and reported as stopped.
 */
export async function checkpointSwarmSandboxes(
  db: ArchiveWriter,
  driver: Pick<SandboxDriver, "provider" | "snapshot">,
  swarmId: string,
  label: string,
): Promise<CheckpointResult> {
  if (!driver.snapshot) {
    return { checkpointed: [], skipped: "this deployment's sandboxes cannot be snapshotted" };
  }
  const rows = await liveSwarmSandboxes(db, swarmId);
  if (rows.length === 0) return { checkpointed: [], skipped: "this swarm holds no machine" };

  const checkpointed: { sandboxId: string; checkpointId: string }[] = [];
  for (const row of rows) {
    const handle: SandboxHandle = {
      externalId: row.externalId,
      provider: row.provider,
      workdir: row.workdir,
    };
    try {
      const checkpointId = await driver.snapshot(handle, label);
      await db
        .update(sandboxes)
        // Hibernated rather than ready: the row now says what a person
        // reading it would want to know, which is that nothing is
        // working in this machine and it has a point to come back to.
        .set({ checkpointId, status: "hibernated", updatedAt: new Date() })
        .where(eq(sandboxes.id, row.id));
      checkpointed.push({ sandboxId: row.id, checkpointId });
    } catch (err) {
      console.error(
        `could not checkpoint sandbox ${row.externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { checkpointed, skipped: null };
}

/**
 * Whether archiving this swarm should reap its machines.
 *
 * Only a swarm that is actually finished with. A swarm somebody
 * archived while it was still running is a person tidying their strip
 * rather than a person finished with the work, and destroying a
 * machine an agent is working in would leave a branch nobody chose.
 * The archive still happens; only the reap waits.
 */
export function archiveReapsSandboxes(swarm: Pick<typeof swarms.$inferSelect, "status">): boolean {
  return ["done", "failed", "cancelled", "budget_exhausted", "timed_out"].includes(swarm.status);
}
