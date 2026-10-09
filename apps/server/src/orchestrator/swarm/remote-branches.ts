import { asc, eq } from "drizzle-orm";
import { repositories, sandboxes, swarmTasks, swarms } from "@bento/db";
import type { GitHubPublisher } from "@bento/github";
import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";
import { captureJobErrors } from "../../analytics.js";
import type { AppContext } from "../../context.js";
import { githubConnectionFor } from "../../github.js";
import { wakeSwarmSandbox } from "../hibernate-sandbox.js";
import { fetchRemoteBranchBundle, pushBranches, recordPushedHead, type PublishableRepository } from "../publish.js";
import { QUEUE_POLL_SECONDS } from "../queue.js";
import { driverForSandbox } from "../sandbox-driver.js";
import { workerBranchName } from "./branches.js";
import { swarmBranchName, swarmTaskWorkspaceKey, swarmWorkspaceKey } from "./sandbox.js";

/**
 * A swarm's branches leave their machines as soon as there is
 * something on them.
 *
 * Before this, a swarm's work existed only inside sandboxes until the
 * swarm finished: a worker's branch in the worker's machine, every
 * landed task in the swarm's. A swarm lost three landed tasks when its
 * machine was reaped, and nothing anywhere else held a copy. Now a
 * worker's branch is pushed to GitHub when its run ends, and after
 * every landing the swarm's branch is pushed, along with the landed
 * task's branch set to the swarm's head at that moment. That last push
 * is what makes stacked pull requests possible at the end: task N's
 * branch is exactly task N-1's plus task N.
 *
 * No pull request is opened here; that is a person's choice once the
 * swarm is done. A project with no GitHub connection or no remote is
 * left as it was.
 */

/** The queue every push of a swarm's branches goes through. */
export const SWARM_PUSH_QUEUE = "swarm.push";

export type SwarmPushJob =
  /** A worker's (or a resolver's) run ended: push the task's branch as it is. */
  | { kind: "task"; taskId: string }
  /**
   * The swarm's branch moved: push it, and when a task just landed, set
   * that task's branch to the swarm's head at its landing.
   */
  | { kind: "swarm"; swarmId: string; landedTaskId?: string };

/**
 * What a test puts in place of GitHub: a publisher of its own and a
 * bare repository on disk. Production passes nothing.
 */
export interface PushOptions {
  publisher?: GitHubPublisher;
  remoteUrl?: (owner: string, repo: string) => string;
}

const pushWorkers = new WeakSet<object>();

/** Started on first use, for the reason the landing worker is. */
export async function ensureSwarmPushWorker(ctx: AppContext): Promise<void> {
  if (pushWorkers.has(ctx.boss)) return;
  pushWorkers.add(ctx.boss);
  try {
    await ctx.boss.work<SwarmPushJob>(
      SWARM_PUSH_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: QUEUE_POLL_SECONDS },
      captureJobErrors(ctx.analytics, SWARM_PUSH_QUEUE, async (jobs) => {
        for (const job of jobs) await performSwarmPush(ctx, job.data);
      }),
    );
  } catch (err) {
    pushWorkers.delete(ctx.boss);
    throw err;
  }
}

/**
 * Asks for a push. Retried with backoff, because GitHub and the
 * sandbox providers both have bad minutes, and a push that never
 * happens is a branch that exists in one place.
 */
export async function enqueueSwarmPush(ctx: AppContext, job: SwarmPushJob): Promise<void> {
  await ensureSwarmPushWorker(ctx);
  const key = job.kind === "task" ? `task:${job.taskId}` : `swarm:${job.swarmId}:${job.landedTaskId ?? "-"}`;
  await ctx.boss.send(SWARM_PUSH_QUEUE, job, {
    singletonKey: key,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
  });
}

export async function performSwarmPush(ctx: AppContext, job: SwarmPushJob): Promise<void> {
  if (job.kind === "task") await pushTaskBranch(ctx, job.taskId);
  else await pushSwarmBranch(ctx, job.swarmId, job.landedTaskId);
}

type TaskFlags = {
  pushedHeads?: Record<string, string>;
  landedHeads?: Record<string, string>;
};

/** A task's branch as its worker left it. */
export async function pushTaskBranch(ctx: AppContext, taskId: string, options: PushOptions = {}): Promise<void> {
  const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)).limit(1);
  if (!task) return;
  const flags = task.flags as TaskFlags;
  // Landed: the swarm's push owns this branch now, set to the landed
  // form. A retried push of the worker's form must not undo it.
  if (flags.landedHeads && Object.keys(flags.landedHeads).length > 0) return;
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, task.swarmId)).limit(1);
  if (!swarm) return;
  const publisher = options.publisher ?? (await githubConnectionFor(ctx, swarm.organizationId));
  if (!publisher) return;

  const [row] = (await ctx.db.select().from(sandboxes).where(eq(sandboxes.swarmTaskId, task.id)))
    .filter((candidate) => candidate.status !== "destroyed");
  const source = await branchSource(ctx, row, swarmTaskWorkspaceKey(swarm.id, task.id), () =>
    wakeSwarmSandbox(ctx, row!, swarm, task.agentProfileId ?? swarm.workerProfileId),
  );
  // The machine is gone: whatever it held was pushed before it went,
  // or the task is starting over and there is nothing of it to keep.
  if (!source) return;

  const repoRows = await projectRepositories(ctx, swarm.projectId);
  const branch = task.branchName ?? workerBranchName(swarm.branchName ?? swarmBranchName(swarm.slug), task.id);
  const outcome = await pushBranches(publisher, {
    branch,
    repositories: repoRows.map((repo) => publishable(ctx, repo, source)),
    lease: async (repo) => flags.pushedHeads?.[repo.repoUrl] ?? null,
    record: (repo, headSha) => recordPushedHead(ctx.db, { taskId: task.id }, repo.repoUrl, headSha),
    ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
  });
  failLoudly(outcome.failures, `swarm task ${task.id}`);
}

/** The swarm's branch, and the branch of the task that just landed on it. */
export async function pushSwarmBranch(
  ctx: AppContext,
  swarmId: string,
  landedTaskId?: string,
  options: PushOptions = {},
): Promise<void> {
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId)).limit(1);
  if (!swarm) return;
  const publisher = options.publisher ?? (await githubConnectionFor(ctx, swarm.organizationId));
  if (!publisher) return;
  const [row] = swarm.sandboxId
    ? (await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId))).filter(
        (candidate) => candidate.status !== "destroyed",
      )
    : [];
  const source = await branchSource(ctx, row, swarmWorkspaceKey(swarm.id), () =>
    wakeSwarmSandbox(ctx, row!, swarm, swarm.plannerProfileId),
  );
  if (!source) return;

  const repoRows = await projectRepositories(ctx, swarm.projectId);
  // One export per repository, shared by both pushes below.
  const exports = new Map<string, ReturnType<NonNullable<PublishableRepository["exportBundle"]>>>();
  const shared = (repo: (typeof repoRows)[number]): PublishableRepository => {
    const base = publishable(ctx, repo, source);
    if (!base.exportBundle) return base;
    const exportBundle = base.exportBundle;
    return {
      ...base,
      exportBundle: () => {
        let pending = exports.get(repo.name);
        if (!pending) {
          pending = exportBundle();
          exports.set(repo.name, pending);
        }
        return pending;
      },
    };
  };

  const swarmBranch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const failures = (
    await pushBranches(publisher, {
      branch: swarmBranch,
      repositories: repoRows.map(shared),
      lease: async (repo) => swarm.pushedHeads?.[repo.repoUrl] ?? null,
      record: (repo, headSha) => recordPushedHead(ctx.db, { swarmId: swarm.id }, repo.repoUrl, headSha),
      ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
    })
  ).failures;

  if (landedTaskId) {
    const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, landedTaskId)).limit(1);
    const flags = (task?.flags ?? {}) as TaskFlags;
    const landedHeads = flags.landedHeads ?? {};
    if (task && Object.keys(landedHeads).length > 0) {
      const branch = task.branchName ?? workerBranchName(swarmBranch, task.id);
      const outcome = await pushBranches(publisher, {
        branch,
        repositories: repoRows.filter((repo) => landedHeads[repo.name]).map(shared),
        target: (repo) => landedHeads[repo.name],
        lease: async (repo) => flags.pushedHeads?.[repo.repoUrl] ?? null,
        record: (repo, headSha) => recordPushedHead(ctx.db, { taskId: task.id }, repo.repoUrl, headSha),
        ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
      });
      failures.push(...outcome.failures);
    }
  }
  failLoudly(failures, `swarm ${swarm.id}`);
}

/**
 * A branch Bento pushed, read back from GitHub, per repository: what a
 * machine that is gone is rebuilt from. The swarm's own machine is made
 * again on its branch from these, and a worker whose swarm machine is
 * gone starts from them rather than from the base branch. Empty when
 * there is no GitHub connection or nothing was ever pushed.
 */
export async function remoteBranchBundles(
  ctx: AppContext,
  input: {
    organizationId: string | null;
    branch: string;
    pushedHeads: Record<string, string> | undefined;
    repoRows: (typeof repositories.$inferSelect)[];
    selfContained?: boolean;
  },
  options: PushOptions = {},
): Promise<Map<string, { branch: string; data: Buffer; headSha: string; baseSha: string }>> {
  const bundles = new Map<string, { branch: string; data: Buffer; headSha: string; baseSha: string }>();
  if (!input.pushedHeads || Object.keys(input.pushedHeads).length === 0) return bundles;
  const publisher = options.publisher ?? (await githubConnectionFor(ctx, input.organizationId));
  if (!publisher) return bundles;
  for (const repo of input.repoRows) {
    if (!repo.repoUrl || !input.pushedHeads[repo.repoUrl]) continue;
    const githubRepoId = repo.githubRepoId ? Number(repo.githubRepoId) : undefined;
    const bundle = await fetchRemoteBranchBundle(
      publisher,
      {
        repoUrl: repo.repoUrl,
        githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
        defaultBranch: repo.defaultBranch,
      },
      input.branch,
      { selfContained: input.selfContained === true, ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}) },
    );
    if (bundle) {
      bundles.set(repo.name, { branch: input.branch, data: bundle.data, headSha: bundle.headSha, baseSha: bundle.baseSha });
    }
  }
  return bundles;
}

/**
 * Where a branch is read from: the machine, through its driver, when
 * the checkouts live in one (woken first if it is hibernated), or the
 * host worktree when they live on this host. Null when the machine
 * that held it is gone.
 */
async function branchSource(
  ctx: AppContext,
  row: typeof sandboxes.$inferSelect | undefined,
  workspaceKey: string,
  wake: () => Promise<void>,
): Promise<{ driver: SandboxDriver; handle: SandboxHandle } | { worktreeKey: string } | null> {
  if (row) {
    const driver = driverForSandbox(ctx.drivers, row);
    if (driver.workspace === "clone") {
      if (!driver.exportRepository) return null;
      await wake();
      return { driver, handle: { externalId: row.externalId, provider: driver.provider, workdir: row.workdir } };
    }
    return { worktreeKey: workspaceKey };
  }
  return ctx.drivers.default.workspace === "host" ? { worktreeKey: workspaceKey } : null;
}

function publishable(
  ctx: AppContext,
  repo: typeof repositories.$inferSelect,
  source: { driver: SandboxDriver; handle: SandboxHandle } | { worktreeKey: string },
): PublishableRepository {
  const githubRepoId = repo.githubRepoId ? Number(repo.githubRepoId) : undefined;
  return {
    id: repo.id,
    name: repo.name,
    repoUrl: repo.repoUrl,
    githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
    defaultBranch: repo.defaultBranch,
    ...("driver" in source
      ? { exportBundle: () => source.driver.exportRepository!(source.handle, repo.name, repo.defaultBranch) }
      : { worktreePath: ctx.worktrees.worktreePath(source.worktreeKey, repo.name) }),
  };
}

async function projectRepositories(ctx: AppContext, projectId: string) {
  return ctx.db.select().from(repositories).where(eq(repositories.projectId, projectId)).orderBy(asc(repositories.position));
}

/** A push that failed is thrown, so the queue tries it again and error tracking hears of it. */
function failLoudly(failures: { name: string; reason: string }[], what: string): void {
  if (failures.length === 0) return;
  throw new Error(`could not push the branches of ${what}: ${failures.map((f) => `${f.name}: ${f.reason}`).join("; ")}`);
}
