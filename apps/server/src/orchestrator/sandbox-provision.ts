import { and, eq, isNull, sql } from "drizzle-orm";
import { repositories, sandboxes } from "@bento/db";
import { ModalProvisionLeak, persistedSandboxProvider, type PreparedRepository, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import type { AgentBinary } from "@bento/sandbox";
import { githubConnectionFor } from "../github.js";
import { duplicateRepositoryLocation } from "../repository-identity.js";
import { createRepositorySeed } from "./publish.js";
import { reportSandboxProvisioned, type SandboxSelection } from "./sandbox-metrics.js";
import { isolationRefusal, type WorkerIsolation } from "./swarm/sandbox.js";

/**
 * Getting a machine with the project's repositories on one branch.
 *
 * Extracted from the card executor rather than written again beside it.
 * Everything here is about a workspace and not about a card: which
 * driver needs worktrees and which clones, where a container's .git has
 * to be mounted so commits can be written, which repositories need a
 * seed bundle because credentials must not enter the sandbox, and what
 * the sandboxes row has to say afterwards so the reaper can find the
 * machine. A swarm needs all of it and none of it is about stages, so
 * the two boards provision through one function and a fix to any of
 * those reaches both.
 *
 * What stays with the callers: what to do when this throws. A card
 * fails its run and re-evaluates its gate; a swarm records the failure
 * on the swarm. Neither answer belongs here.
 */

export interface ProvisionWorkspaceInput {
  projectId: string;
  organizationId: string | null;
  /**
   * The name this workspace is known by: the host directory the
   * worktrees live in, and the stem of the machine's name.
   *
   * A card passes its feature id, which is what every existing sprite
   * and container is already named after. A swarm passes its own key,
   * which is why this is a string rather than a feature id: two boards
   * name their machines, and only one of them has cards.
   */
  workspaceKey: string;
  /** The branch every repository is checked out on. */
  branch: string;
  repoRows: (typeof repositories.$inferSelect)[];
  /** Read-only mounts of the user's own agent logins, in local mode. */
  authMounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  restrictNetwork: boolean;
  /**
   * The agent CLIs this machine needs, when the caller can narrow it.
   * Omitted means the whole set, which is what a swarm's machine gets:
   * only a card has a pipeline whose stages name their agents.
   */
  agentBinaries?: readonly AgentBinary[];
  /**
   * What the caller promised about where its agents work,
   * when the caller has one.
   *
   * A card has none: a stage's checkout is wherever the driver puts
   * it, and no row anywhere says otherwise. A swarm does, because the
   * merge queue is built around the answer, and a swarm whose shape
   * changed underneath it would be a merge queue with nothing to move.
   */
  workerIsolation?: WorkerIsolation;
  /** Which rows this machine belongs to. Exactly one board's worth. */
  owner: { featureId: string } | { swarmId: string; swarmTaskId?: string | null };
  /**
   * Repository urls whose work has landed, so this workspace is not on
   * the branch it was built for.
   *
   * Today only a card sets it, when its pull request merged and it has
   * started another branch: an existing worktree is moved rather than
   * left where the agent was working, and the repositories that
   * actually merged start again from the base branch. A repository
   * whose publish failed, or that never opened a pull request, still
   * holds commits nobody has landed, so its new branch starts where its
   * old one stood and that work travels with the card.
   */
  restartedRepoUrls?: string[];
  /**
   * The branch a new branch here starts from, instead of each
   * repository's default branch.
   *
   * A swarm's worker sets it to the swarm's branch, and that is the
   * whole of what makes a swarm one change rather than several. A leaf
   * branched off the repository's default branch has none of what the
   * leaves before it landed, so its agent writes against code that is
   * already out of date and its branch conflicts with every one of
   * them at the merge queue. Only the branch's starting point: an
   * existing worktree is left where its agent was working, the way a
   * card's is.
   */
  startFromBranch?: string;
  /**
   * The commits that make `startFromBranch`, per repository, for a
   * driver that cannot be shown a ref on this server.
   *
   * A sprite clones from the remote, and a swarm's branch has never
   * been pushed to one: it exists only inside the machine the merge
   * queue has been landing onto. So the branch travels as a bundle
   * rather than as a name, and the sandbox fetches it before cutting
   * the run's branch from it. Empty or absent on every driver whose
   * checkouts are on this host, where the name is enough.
   */
  startFromBundles?: Map<string, { branch: string; data: Buffer }>;
  /**
   * Hosts a restricted Modal sandbox may open. Other drivers ignore it.
   * The caller names them from the gateway, the clone URLs, and the
   * agent's base URLs, because those are not known in here.
   */
  allowedHosts?: string[];
  /** Progress lines, which go into the transcript of whatever asked. */
  say: (text: string) => Promise<void>;
  /**
   * The driver this machine belongs to. Chosen by the caller from the
   * live sandbox row, or from the project when there is no machine yet.
   */
  driver: SandboxDriver;
  /**
   * Drivers to try in turn when `driver` cannot provision, in order.
   * A project on "auto" passes Modal behind the sprite; everything
   * else passes none, so a named provider fails plainly rather than
   * landing somewhere the project did not ask for. Only drivers whose
   * workspace shape matches `driver` are tried: the worktrees and seed
   * bundles above are prepared once, for that shape.
   */
  fallbackDrivers?: SandboxDriver[];
  /** Why `driver` was chosen, for the metric. Default when absent. */
  selection?: SandboxSelection;
  /** The person who started the run, for the metric. */
  startedBy?: string | null;
}

export interface ProvisionedWorkspace {
  handle: SandboxHandle;
  prepared: PreparedRepository[];
  sandboxRow: typeof sandboxes.$inferSelect | undefined;
  /**
   * The driver that made the machine. The caller's `driver` when that
   * one answered, else the fallback that did, and the caller must use
   * this one from here on: exec, attach and destroy all go through
   * the driver that owns the handle.
   */
  driver: SandboxDriver;
}

/** A provider's name as a transcript line says it. */
function providerLabel(provider: string): string {
  if (provider === "sprite") return "Fly Sprites";
  if (provider === "modal") return "Modal";
  return provider;
}

export async function provisionWorkspace(
  ctx: AppContext,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  const { repoRows, branch, workspaceKey, driver } = input;
  const publisher = await githubConnectionFor(ctx, input.organizationId);
  /**
   * Every driver that may make this machine, first choice first. A
   * fallback of another workspace shape is left out rather than tried:
   * the checkout below is prepared for one shape, and a host driver
   * handed clone-shaped input would mount nothing.
   */
  const candidates = [
    driver,
    ...(input.fallbackDrivers ?? []).filter((d) => d.workspace === driver.workspace && d !== driver),
  ];

  /**
   * Two repositories pointing at one checkout would have their
   * worktrees fight over the same .git, so the run stops here with a
   * sentence naming both rather than failing somewhere further in.
   */
  const duplicateRepos = duplicateRepositoryLocation(repoRows);
  if (duplicateRepos) {
    throw new Error(
      `Repositories ${duplicateRepos[0].name} and ${duplicateRepos[1].name} use the same checkout. ` +
        "Remove one under Settings, Repositories, then run again.",
    );
  }

  /**
   * The shape the caller promised, before anything is created.
   *
   * Above the duplicate check rather than below it because this is the
   * cheapest refusal there is: a swarm that asserts checkouts on
   * this server, on a driver whose sandboxes hold their own clones, is
   * a swarm that cannot land a single branch. Better to say that than
   * to provision the machine and find out at the merge queue.
   */
  const shape = isolationRefusal(input.workerIsolation ?? "sandbox", driver.workspace);
  if (shape) throw new Error(shape);

  const restarted = new Set(input.restartedRepoUrls ?? []);
  const prepared: PreparedRepository[] =
    driver.workspace === "clone"
      ? repoRows.map((r) => ({ name: r.name, localPath: r.localPath, worktreePath: "" }))
      : await ctx.worktrees.ensureAll(
          repoRows.map((r) => ({
            name: r.name,
            localPath: r.localPath,
            defaultBranch: r.defaultBranch,
            ...(r.repoUrl && restarted.has(r.repoUrl)
              ? { startFromBranch: r.defaultBranch }
              : input.startFromBranch
                ? { startFromBranch: input.startFromBranch }
                : {}),
          })),
          workspaceKey,
          branch,
          { branchChanged: restarted.size > 0 },
        );

  /**
   * A worktree's .git is a file naming the source repository's .git
   * directory on the host, and commits write there too (objects, refs,
   * the worktree's own state). Without these mounts git inside the
   * container cannot even report status, so no containerised agent
   * could ever commit. Mounted at the same absolute path the .git file
   * names, writable because committing writes.
   */
  const repoGitMounts = (candidate: SandboxDriver) =>
    candidate.provider === "docker"
      ? repoRows.map((r) => ({
          hostPath: `${r.localPath.replace(/\/$/, "")}/.git`,
          containerPath: `${r.localPath.replace(/\/$/, "")}/.git`,
          readOnly: false,
        }))
      : [];

  const seedBundles = new Map<string, Buffer>();
  // The base branch the seed actually carries, which is not the stored
  // default branch when that name no longer exists on the remote. The
  // sandbox must branch off the name the bundle has, not the stale one.
  const seedBaseBranches = new Map<string, string>();
  if (driver.workspace === "clone" && publisher) {
    for (const row of repoRows) {
      if (!row.repoUrl) continue;
      const repoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
      const seed = await createRepositorySeed(
        publisher,
        row.repoUrl,
        Number.isSafeInteger(repoId) ? repoId : undefined,
        row.defaultBranch,
      );
      seedBundles.set(row.id, seed.bundle);
      seedBaseBranches.set(row.id, seed.baseBranch);
    }
  }

  /**
   * An organization that locked its agents down gets a sandbox with no
   * route out, or no sandbox at all. Falling back to open egress would
   * turn a security setting into a decoration, so a driver that cannot
   * honor it is not asked, and when none of them can this fails with
   * the reason instead. On "auto" that is what puts a locked team's
   * runs straight on Modal: a sprite has no restricted network.
   */
  const usable = input.restrictNetwork ? candidates.filter((d) => d.supportsRestrictedNetwork) : candidates;
  if (usable.length === 0) {
    throw new Error(
      "This organization requires agents to run without network access, and this deployment has no restricted network configured. Set BENTO_SANDBOX_RESTRICTED_NETWORK, or turn the setting off under Team.",
    );
  }

  const provisionWith = async (candidate: SandboxDriver): Promise<SandboxHandle> => {
    const restore = candidate.provider === "modal" ? await hibernatedRestore(ctx, input.owner) : undefined;
    return candidate.provision({
      projectId: input.projectId,
      workspaceKey,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(restore?.imageRef ? { imageRef: restore.imageRef } : {}),
      ...(restore?.missingSnapshot ? { missingSnapshot: true } : {}),
      ...(input.restrictNetwork ? { network: "restricted" as const } : {}),
      ...(input.allowedHosts ? { allowedHosts: input.allowedHosts } : {}),
      hostWorkspacePath: ctx.worktrees.workspacePath(workspaceKey),
      // Drivers with no host filesystem clone these instead of mounting.
      repositories: repoRows.map((r) => ({
        name: r.name,
        cloneUrl: r.repoUrl ?? undefined,
        branch,
        baseBranch: seedBaseBranches.get(r.id) ?? r.defaultBranch,
        seedBundle: seedBundles.get(r.id),
        startBundle: input.startFromBundles?.get(r.name),
      })),
      // Local mode can share the user's own agent logins and git identity.
      ...(input.agentBinaries ? { agentBinaries: input.agentBinaries } : {}),
      mounts: [...repoGitMounts(candidate), ...input.authMounts],
      image: ctx.env.BENTO_SANDBOX_IMAGE,
      onProgress: input.say,
    });
  };

  /**
   * First driver that answers wins. A driver that throws is cleaned up
   * after (a Modal machine it leaked is destroyed), and the next one
   * is asked; the last one's error is the run's. The move is said in
   * the transcript and counted in error tracking, because a sprite
   * that keeps failing is something to look at even while every run
   * still lands on Modal.
   */
  let chosen: SandboxDriver = usable[0]!;
  let handle: SandboxHandle | undefined;
  let fellBackFrom: string | null = null;
  let attempts = 0;
  for (const candidate of usable) {
    attempts += 1;
    try {
      handle = await provisionWith(candidate);
      chosen = candidate;
      break;
    } catch (err) {
      await cleanupFailedAttempt(ctx, candidate, err, input.owner);
      const next = usable[attempts];
      if (!next) throw err;
      fellBackFrom ??= candidate.provider;
      const reason = err instanceof ModalProvisionLeak ? (err.cause ?? err) : err;
      console.warn(
        `${candidate.provider} could not provision a sandbox for ${workspaceKey}; trying ${next.provider}:`,
        reason,
      );
      ctx.analytics?.captureException(reason, input.startedBy ?? null, input.organizationId, {
        source: "sandbox_provision_fallback",
        provider: candidate.provider,
        next_provider: next.provider,
        project_id: input.projectId,
        ...("featureId" in input.owner
          ? { feature_id: input.owner.featureId }
          : { swarm_id: input.owner.swarmId, swarm_task_id: input.owner.swarmTaskId ?? null }),
      });
      await input.say(
        `${providerLabel(candidate.provider)} could not provide a sandbox (${reasonSentence(reason)}). Trying ${providerLabel(next.provider)}.`,
      );
    }
  }
  if (!handle) throw new Error("no sandbox driver provisioned a machine");
  const driverUsed = chosen;

  try {
    /**
     * An upsert, not insert-or-ignore. The machine was just provisioned,
     * so whatever the row said before, it is real and awake now.
     *
     * Ignoring the conflict was how two bugs lived in one line. A card
     * reopened after its sandbox was reaped provisions a new machine
     * under the same name, and the ignored insert left the row saying
     * "destroyed": the reaper filters that status out, so the new machine
     * was never destroyed again and billed forever. And the size recorded
     * at provision never reached an existing row, so a deployment on large
     * sprites metered every hour at the standard rate.
     */
    const [sandboxRow] = await ctx.db
      .insert(sandboxes)
      .values({
        projectId: input.projectId,
        ...input.owner,
        provider: persistedSandboxProvider(handle.provider),
        externalId: handle.externalId,
        status: "busy",
        workdir: handle.workdir,
        // What this machine costs, in the price list's own words. Taken
        // from the driver at the moment it was created, so changing the
        // deployment's default size later cannot reprice hours already
        // spent. Absent on the local drivers, which bill nobody.
        ...(driverUsed.sandboxSize ? { size: driverUsed.sandboxSize } : {}),
      })
      .onConflictDoUpdate({
        target: sandboxes.externalId,
        set: sandboxProvisionConflict({
          ...input.owner,
          provider: persistedSandboxProvider(handle.provider),
          workdir: handle.workdir,
          ...(driverUsed.sandboxSize ? { size: driverUsed.sandboxSize } : {}),
          ...(handle.recordedImageRef !== undefined ? { recordedImageRef: handle.recordedImageRef } : {}),
        }),
      })
      .returning();

    reportSandboxProvisioned(ctx.analytics, {
      provider: handle.provider,
      selection: input.selection ?? "default",
      fellBackFrom,
      attempts,
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.startedBy ?? null,
      ...("featureId" in input.owner
        ? { featureId: input.owner.featureId }
        : { swarmId: input.owner.swarmId, swarmTaskId: input.owner.swarmTaskId ?? null }),
    });

    return { handle, prepared, sandboxRow, driver: driverUsed };
  } catch (err) {
    // A machine this attempt created, and then failed to record, would
    // bill with nobody looking.
    if (handle.createdSandbox) {
      const created = handle;
      await driverUsed
        .destroy({
          externalId: created.externalId,
          provider: created.provider,
          workdir: created.workdir,
        })
        .catch((destroyErr) => {
          console.warn(`could not destroy sandbox ${created.externalId} after a failed provision:`, destroyErr);
        });
    }
    throw err;
  }
}

/** The error a transcript line can carry: its sentence, on one line. */
function reasonSentence(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "unknown error";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * What a driver that threw out of provision leaves behind.
 *
 * Only Modal says: a machine it made and then lost track of comes
 * back as ModalProvisionLeak, and is destroyed here so it does not
 * bill with nobody looking. A hibernated row for this owner would
 * also hide it from the sweep, so that row stops counting as live.
 * Every other driver either made nothing or cleaned up itself.
 */
async function cleanupFailedAttempt(
  ctx: AppContext,
  driver: SandboxDriver,
  err: unknown,
  owner: { featureId: string } | { swarmId: string; swarmTaskId?: string | null },
): Promise<void> {
  if (!(err instanceof ModalProvisionLeak)) return;
  const ownerWhere =
    "featureId" in owner
      ? eq(sandboxes.featureId, owner.featureId)
      : and(
          eq(sandboxes.swarmId, owner.swarmId),
          owner.swarmTaskId ? eq(sandboxes.swarmTaskId, owner.swarmTaskId) : isNull(sandboxes.swarmTaskId),
        );
  await ctx.db
    .update(sandboxes)
    .set({ status: "destroyed" })
    .where(and(ownerWhere, eq(sandboxes.status, "hibernated")))
    .catch(() => {});
  await driver
    .destroy({
      externalId: err.externalId,
      provider: "modal",
      workdir: "/workspace",
    })
    .catch(() => {});
}

/**
 * Conflict update for a sandbox row whose machine was just provisioned.
 *
 * A ready or busy row keeps its provider. A destroyed row takes the
 * new one, because the name was reused. `recordedImageRef` null drops
 * a hibernation image this start did not use. Absent leaves the stored
 * id, except on a destroyed row, which drops it.
 *
 * The owner columns are whichever board this machine belongs to. A
 * card sets its feature. A swarm sets the swarm, and the task when
 * the machine is a worker's.
 */
export function sandboxProvisionConflict(input: {
  featureId?: string;
  swarmId?: string;
  swarmTaskId?: string | null;
  provider: "docker" | "sprite" | "modal";
  workdir: string;
  size?: string;
  recordedImageRef?: string | null;
}) {
  return {
    ...(input.featureId !== undefined ? { featureId: input.featureId } : {}),
    ...(input.swarmId !== undefined
      ? { swarmId: input.swarmId, swarmTaskId: input.swarmTaskId ?? null }
      : {}),
    status: "busy" as const,
    workdir: input.workdir,
    ...(input.size ? { size: input.size } : {}),
    lastUsedAt: new Date(),
    provider: sql`CASE WHEN ${sandboxes.status} = 'destroyed' THEN ${input.provider} ELSE ${sandboxes.provider} END`,
    imageRef:
      input.recordedImageRef !== undefined
        ? input.recordedImageRef
        : sql`CASE WHEN ${sandboxes.status} = 'destroyed' THEN NULL ELSE ${sandboxes.imageRef} END`,
  };
}

/**
 * What a hibernated machine of this workspace can be restored from.
 *
 * A card looks up its feature. A swarm looks up its own machine, or
 * the worker's, so a later run restores that checkout instead of
 * cloning again. A row that is merely busy is a live machine and is
 * not restored from here.
 */
async function hibernatedRestore(
  ctx: AppContext,
  owner: { featureId: string } | { swarmId: string; swarmTaskId?: string | null },
): Promise<{ imageRef?: string; missingSnapshot: boolean }> {
  const where =
    "featureId" in owner
      ? and(eq(sandboxes.featureId, owner.featureId), eq(sandboxes.status, "hibernated"))
      : and(
          eq(sandboxes.swarmId, owner.swarmId),
          owner.swarmTaskId ? eq(sandboxes.swarmTaskId, owner.swarmTaskId) : isNull(sandboxes.swarmTaskId),
          eq(sandboxes.status, "hibernated"),
        );
  const [row] = await ctx.db.select({ imageRef: sandboxes.imageRef }).from(sandboxes).where(where).limit(1);
  if (!row) return { missingSnapshot: false };
  if (row.imageRef) return { imageRef: row.imageRef, missingSnapshot: false };
  // The row says hibernated and no image id survived. The next start
  // has to say it is a fresh clone, rather than restoring whatever
  // older image the process can still see.
  return { missingSnapshot: true };
}

/** The repositories a project spans, in the order the board shows them. */
export async function projectRepositories(ctx: AppContext, projectId: string) {
  return ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(repositories.position);
}
