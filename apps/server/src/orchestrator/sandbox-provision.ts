import { eq } from "drizzle-orm";
import { repositories, sandboxes } from "@bento/db";
import type { PreparedRepository, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import type { AgentBinary } from "@bento/sandbox";
import { githubConnectionFor } from "../github.js";
import { duplicateRepositoryLocation } from "../repository-identity.js";
import { createRepositorySeed } from "./publish.js";
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
   * What the caller's template promised about where its agents work,
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
   * cheapest refusal there is: a template that asserts checkouts on
   * this server, on a driver whose sandboxes hold their own clones, is
   * a swarm that cannot land a single branch. Better to say that than
   * to provision the machine and find out at the merge queue.
   */
  const shape = isolationRefusal(input.workerIsolation ?? "sandbox", ctx.driver.provider);
  if (shape) throw new Error(shape);

  const restarted = new Set(input.restartedRepoUrls ?? []);
  const prepared: PreparedRepository[] =
    ctx.driver.provider === "sprite"
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
  const repoGitMounts =
    ctx.driver.provider === "docker"
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
  if (ctx.driver.provider === "sprite" && publisher) {
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
    workspaceKey,
    ...(input.restrictNetwork ? { network: "restricted" as const } : {}),
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
