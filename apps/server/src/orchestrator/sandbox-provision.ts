import { eq } from "drizzle-orm";
import { repositories, sandboxes } from "@bento/db";
import type { PreparedRepository, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { githubConnectionFor } from "../github.js";
import { createRepositorySeed } from "./publish.js";

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
  /** Which rows this machine belongs to. Exactly one board's worth. */
  owner: { featureId: string } | { swarmId: string; swarmTaskId?: string | null };
  /** Progress lines, which go into the transcript of whatever asked. */
  say: (text: string) => Promise<void>;
}

export interface ProvisionedWorkspace {
  handle: SandboxHandle;
  prepared: PreparedRepository[];
  sandboxRow: typeof sandboxes.$inferSelect | undefined;
}

export async function provisionWorkspace(
  ctx: AppContext,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  const { repoRows, branch, workspaceKey } = input;
  const publisher = await githubConnectionFor(ctx, input.organizationId);

  const prepared: PreparedRepository[] =
    ctx.driver.provider === "sprite"
      ? repoRows.map((r) => ({ name: r.name, localPath: r.localPath, worktreePath: "" }))
      : await ctx.worktrees.ensureAll(
          repoRows.map((r) => ({ name: r.name, localPath: r.localPath })),
          workspaceKey,
          branch,
        );

  /**
   * A worktree's .git is a file naming the source repository's .git
   * directory on the host, and commits write there too (objects, refs,
   * the worktree's own state). Without these mounts git inside the
   * container cannot even report status, so no containerised agent
   * could ever commit. Mounted at the same absolute path the .git file
   * names, writable because committing writes.
   */
  const repoGitMounts =
    ctx.driver.provider === "docker"
      ? repoRows.map((r) => ({
          hostPath: `${r.localPath.replace(/\/$/, "")}/.git`,
          containerPath: `${r.localPath.replace(/\/$/, "")}/.git`,
          readOnly: false,
        }))
      : [];

  const seedBundles = new Map<string, Buffer>();
  if (ctx.driver.provider === "sprite" && publisher) {
    for (const row of repoRows) {
      if (!row.repoUrl) continue;
      const repoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
      seedBundles.set(
        row.id,
        await createRepositorySeed(
          publisher,
          row.repoUrl,
          Number.isSafeInteger(repoId) ? repoId : undefined,
          row.defaultBranch,
        ),
      );
    }
  }

  /**
   * An organization that locked its agents down gets a sandbox with no
   * route out, or no sandbox at all. Falling back to open egress would
   * turn a security setting into a decoration, so this fails with the
   * reason instead.
   */
  if (input.restrictNetwork && !ctx.driver.supportsRestrictedNetwork) {
    throw new Error(
      "This organization requires agents to run without network access, and this deployment has no restricted network configured. Set BENTO_SANDBOX_RESTRICTED_NETWORK, or turn the setting off under Team.",
    );
  }

  const handle = await ctx.driver.provision({
    projectId: input.projectId,
    // The driver's own name for the workspace. It has always been the
    // card's id here, and a swarm's key takes the same slot.
    featureId: workspaceKey,
    ...(input.restrictNetwork ? { network: "restricted" as const } : {}),
    hostWorkspacePath: ctx.worktrees.workspacePath(workspaceKey),
    // Drivers with no host filesystem clone these instead of mounting.
    repositories: repoRows.map((r) => ({
      name: r.name,
      cloneUrl: r.repoUrl ?? undefined,
      branch,
      baseBranch: r.defaultBranch,
      seedBundle: seedBundles.get(r.id),
    })),
    // Local mode can share the user's own agent logins and git identity.
    mounts: [...repoGitMounts, ...input.authMounts],
    image: ctx.env.BENTO_SANDBOX_IMAGE,
    onProgress: input.say,
  });

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
      provider: handle.provider === "sprite" ? "sprite" : "docker",
      externalId: handle.externalId,
      status: "busy",
      workdir: handle.workdir,
      // What this machine costs, in the price list's own words. Taken
      // from the driver at the moment it was created, so changing the
      // deployment's default size later cannot reprice hours already
      // spent. Absent on the local drivers, which bill nobody.
      ...(ctx.driver.sandboxSize ? { size: ctx.driver.sandboxSize } : {}),
    })
    .onConflictDoUpdate({
      target: sandboxes.externalId,
      set: {
        ...input.owner,
        status: "busy",
        workdir: handle.workdir,
        ...(ctx.driver.sandboxSize ? { size: ctx.driver.sandboxSize } : {}),
        lastUsedAt: new Date(),
      },
    })
    .returning();

  return { handle, prepared, sandboxRow };
}

/** The repositories a project spans, in the order the board shows them. */
export async function projectRepositories(ctx: AppContext, projectId: string) {
  return ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(repositories.position);
}
