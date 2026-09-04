import { eq } from "drizzle-orm";
import { organizationPolicies, projects, repositories, sandboxes, swarms } from "@bento/db";
import type { PreparedRepository, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { provisionWorkspace } from "../sandbox-provision.js";
import { linkGitHubRemotes } from "../repo-remote.js";

/**
 * The swarm's own machine, and the branch everything lands on.
 *
 * A swarm has one branch and the server owns it. The planner runs on
 * this machine, and so does the merge queue, which is the reason the
 * two are one thing: landing a worker's branch onto the swarm's branch
 * is a git operation in a checkout, and the coordinator has to be the
 * one holding that checkout.
 *
 * Provisioned on the first planner run rather than when the swarm is
 * created. A swarm somebody made and did not start should cost nothing,
 * and a machine provisioned at creation would be paid for from the
 * moment of the click. Every later run finds the same machine: the
 * drivers name it from the workspace key and reuse it, and the row is
 * an upsert on that name.
 */

/**
 * The name this swarm's workspace and machine are known by.
 *
 * Prefixed rather than bare, because a card's workspace key is its
 * feature id and both boards name machines out of the same namespace.
 * Two uuids could not collide in practice; a prefix means nobody has to
 * know that to read a container list.
 */
export function swarmWorkspaceKey(swarmId: string): string {
  return `swarm-${swarmId}`;
}

/**
 * The branch a swarm lands on, from its slug.
 *
 * The slug is unique per project and stable, so the branch name is
 * legible in a repository ("swarm/checkout-rewrite") rather than a
 * uuid, and a person looking at the remote can tell which swarm made
 * it.
 */
export function swarmBranchName(slug: string): string {
  return `swarm/${slug}`;
}

export interface SwarmWorkspace {
  handle: SandboxHandle;
  prepared: PreparedRepository[];
  repoRows: (typeof repositories.$inferSelect)[];
  project: typeof projects.$inferSelect;
  branch: string;
  restrictNetwork: boolean;
}

/**
 * Provisions (or finds) the swarm's machine and returns everything a
 * run on it needs.
 *
 * Throws rather than returning a reason: every caller is inside a run
 * that has to fail with the message, and a provisioning failure has
 * nothing useful to say about carrying on.
 */
export async function ensureSwarmWorkspace(
  ctx: AppContext,
  input: {
    swarm: typeof swarms.$inferSelect;
    /** Read-only mounts of the user's own agent logins, in local mode. */
    authMounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
    say: (text: string) => Promise<void>;
    /** The leaf this machine is for, when it is a worker's rather than the swarm's. */
    swarmTaskId?: string | null;
  },
): Promise<SwarmWorkspace> {
  const { swarm } = input;
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, swarm.projectId));
  if (!project) throw new Error(`project ${swarm.projectId} not found`);
  if (project.organizationId !== swarm.organizationId) {
    throw new Error(`swarm ${swarm.id} is outside its project's organization`);
  }

  const selected = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(repositories.position);
  if (selected.length === 0) {
    throw new Error(`project ${project.id} has no repositories; add at least one before starting a swarm`);
  }
  // Repositories added by path before their remote was read still have
  // no URL, which anything that publishes would report as "no GitHub
  // remote is linked". Read it from the checkout once, as the card path
  // does.
  const repoRows = ctx.env.BENTO_MODE === "multi" ? selected : await linkGitHubRemotes(ctx.db, selected);

  const branch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const restrictNetwork = await organizationRestrictsNetwork(ctx, swarm.organizationId);

  const workspace = await provisionWorkspace(ctx, {
    projectId: project.id,
    organizationId: swarm.organizationId,
    workspaceKey: swarmWorkspaceKey(swarm.id),
    branch,
    repoRows,
    authMounts: input.authMounts,
    restrictNetwork,
    owner: { swarmId: swarm.id, swarmTaskId: input.swarmTaskId ?? null },
    say: input.say,
  });

  /**
   * The swarm records its branch and its machine the first time it has
   * them. Written rather than derived on every read, because a slug the
   * team renames later must not silently move a swarm onto a second
   * branch, and because stopping a swarm has to find the machine
   * without knowing how its name was built.
   */
  if (swarm.branchName !== branch || swarm.sandboxId !== (workspace.sandboxRow?.id ?? null)) {
    await ctx.db
      .update(swarms)
      .set({
        branchName: branch,
        ...(workspace.sandboxRow ? { sandboxId: workspace.sandboxRow.id } : {}),
        updatedAt: new Date(),
      })
      .where(eq(swarms.id, swarm.id));
    swarm.branchName = branch;
    if (workspace.sandboxRow) swarm.sandboxId = workspace.sandboxRow.id;
  }

  return {
    handle: workspace.handle,
    prepared: workspace.prepared,
    repoRows,
    project,
    branch,
    restrictNetwork,
  };
}

/** Whether this organization has asked for sandboxes with no egress. */
async function organizationRestrictsNetwork(ctx: AppContext, organizationId: string | null): Promise<boolean> {
  if (!organizationId) return false;
  const [row] = await ctx.db
    .select({ restrictNetwork: organizationPolicies.restrictNetwork })
    .from(organizationPolicies)
    .where(eq(organizationPolicies.organizationId, organizationId))
    .limit(1);
  return row?.restrictNetwork === true;
}

/** The machines a swarm is holding, for stopping or reaping them. */
export async function swarmSandboxes(ctx: AppContext, swarmId: string) {
  return ctx.db.select().from(sandboxes).where(eq(sandboxes.swarmId, swarmId));
}
