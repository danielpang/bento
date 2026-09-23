import { and, asc, desc, eq } from "drizzle-orm";
import {
  repositories,
  runArtifacts,
  sandboxes,
  swarmLandings,
  swarmPullRequests,
  swarmTasks,
  swarms,
} from "@bento/db";
import type { GitHubPublisher } from "@bento/github";
import type { SandboxHandle } from "@bento/sandbox";
import { captureJobErrors } from "../../analytics.js";
import type { AppContext } from "../../context.js";
import { githubConnectionFor } from "../../github.js";
import { SWARM_DESIGN_PATH } from "./design-document.js";
import { publishSwarmBranches, type PublishableRepository, type PublishedPullRequest } from "../publish.js";
import { QUEUE_POLL_SECONDS } from "../queue.js";
import { swarmBranchName, swarmWorkspaceKey } from "./sandbox.js";

/**
 * What happens when a swarm is finished.
 *
 * The merge queue has already put every leaf's work on the swarm's
 * branch, one branch at a time, so by the time the root is done the
 * branch is the whole change and nothing is left to merge. What is
 * left is to take it out of Bento: push the branch and open a pull
 * request in every repository the swarm committed in, and record them
 * so the swarm's header can link to them.
 *
 * Through publish.ts rather than beside it. The card board has pushed
 * agent-written branches to GitHub for a year, and everything that
 * makes that safe (the server holds the credential and the agent never
 * does, the bundle leaves the sandbox without a remote configured, the
 * push holds a lease against the commit Bento itself last pushed) is
 * exactly as necessary here. A swarm's publish is the card's publish
 * with different rows and a different body.
 *
 * **The write-up is the planner's, and it is not a new agent turn.**
 * The plan calls for "the planner's write-up, then publish". The
 * planner already writes one: `write_design` is how it records what it
 * decided and why, every agent in the swarm reads it, and it is the
 * only prose in a swarm that is about the change as a whole. It goes
 * into the body as written. Waking the planner one more time to
 * compose a second write-up, and holding the publish until that run
 * settled, would put the swarm's one chance at a pull request behind
 * an agent turn that can fail, run out of budget, or never call a
 * tool, and a finished swarm that never publishes is worse than a
 * pull request whose summary is the design note.
 */

/** The queue a finished swarm's publish goes through. */
export const SWARM_PUBLISH_QUEUE = "swarm.publish";

/**
 * Which pg-boss instances already have a publish worker. Keyed by the
 * boss for the reason the tick and landing sets are: the tests run
 * many contexts in one process, each with its own.
 */
const publishWorkers = new WeakSet<object>();

/** What one completion did, for the log and for the tests. */
export interface SwarmPublishResult {
  published: PublishedPullRequest[];
  failures: { name: string; reason: string }[];
  /** Why nothing was attempted, when nothing was. */
  skipped: string | null;
}

/**
 * Starts the publish worker, if this process has not.
 *
 * Not at boot, and on the ordinary poll rather than the interactive
 * one, for the reasons the landing worker is neither: most deployments
 * have never finished a swarm, and the job is sent by the tick that
 * noticed the swarm was done, which is itself the end of an agent run
 * that took minutes. Ten seconds of pickup lag on top of that is not
 * something anybody can see.
 */
export async function ensureSwarmPublishWorker(ctx: AppContext): Promise<void> {
  if (publishWorkers.has(ctx.boss)) return;
  publishWorkers.add(ctx.boss);
  try {
    await ctx.boss.work<{ swarmId: string }>(
      SWARM_PUBLISH_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: QUEUE_POLL_SECONDS },
      captureJobErrors(ctx.analytics, SWARM_PUBLISH_QUEUE, async (jobs) => {
        for (const job of jobs) await publishFinishedSwarm(ctx, job.data.swarmId);
      }),
    );
  } catch (err) {
    publishWorkers.delete(ctx.boss);
    throw err;
  }
}

/**
 * Asks for a finished swarm to be published.
 *
 * Called after the tick's transaction commits, never inside it, for
 * the reason enqueueLanding is: the row has to say "done" before a
 * worker reads it.
 *
 * Singleton on the swarm, so a swarm that settles, is re-ticked, and
 * settles again does not queue two publishes that race each other onto
 * the same branch.
 */
export async function enqueueSwarmPublish(ctx: AppContext, swarmId: string): Promise<void> {
  await ensureSwarmPublishWorker(ctx);
  await ctx.boss.send(SWARM_PUBLISH_QUEUE, { swarmId }, { singletonKey: swarmId });
}

/**
 * Pushes a finished swarm's branch and opens its pull requests.
 *
 * Safe to run twice, which is what a redelivered job is: the rows are
 * an upsert keyed by swarm and repository, and `ensurePullRequest`
 * finds the pull request it opened the first time rather than opening
 * a second.
 */
export async function publishFinishedSwarm(
  ctx: AppContext,
  swarmId: string,
): Promise<SwarmPublishResult | null> {
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId)).limit(1);
  if (!swarm) return null;
  /**
   * Only a swarm that is actually finished. The job is sent by the
   * tick that saw the status change, and a swarm can move off "done"
   * before the job is picked up (a person reopens it, the planner adds
   * a leaf). Publishing a branch that is being worked again would open
   * a pull request over a change that is not finished.
   */
  if (swarm.status !== "done") {
    return { published: [], failures: [], skipped: `the swarm is ${swarm.status}, not done` };
  }

  const publisher = await githubConnectionFor(ctx, swarm.organizationId);
  if (!publisher) {
    return {
      published: [],
      failures: [],
      skipped:
        "no GitHub connection is configured, so the swarm's branch was not pushed. It is in the repository, and publishing again after connecting GitHub opens the pull requests.",
    };
  }
  return publishSwarmCompletion(ctx, swarm, publisher);
}

/**
 * The work, with the GitHub connection already resolved.
 *
 * Split from the job above because the two halves fail for different
 * reasons and are worth exercising apart: whether this deployment has
 * a credential at all is a question about the organization's settings,
 * and everything below this line is git and rows. A test drives this
 * with a publisher of its own against a bare repository on disk, the
 * way the card path's publish test does, which is the only way any of
 * it gets run outside a deployment that has GitHub.
 */
export async function publishSwarmCompletion(
  ctx: AppContext,
  swarm: typeof swarms.$inferSelect,
  publisher: GitHubPublisher,
  options: { remoteUrl?: (owner: string, repo: string) => string } = {},
): Promise<SwarmPublishResult> {
  const repoRows = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, swarm.projectId))
    .orderBy(asc(repositories.position));
  if (repoRows.length === 0) {
    return { published: [], failures: [], skipped: "this project spans no repositories" };
  }

  const branch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const tasks = await ctx.db
    .select()
    .from(swarmTasks)
    .where(eq(swarmTasks.swarmId, swarm.id))
    .orderBy(asc(swarmTasks.position), asc(swarmTasks.createdAt));
  const landedIds = await ctx.db
    .select({ taskId: swarmLandings.taskId })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.status, "landed")));
  const [design] = await ctx.db
    .select({ content: runArtifacts.content })
    .from(runArtifacts)
    .where(and(eq(runArtifacts.swarmId, swarm.id), eq(runArtifacts.path, SWARM_DESIGN_PATH)))
    .orderBy(desc(runArtifacts.createdAt))
    .limit(1);
  const [document] = await ctx.db
    .select({ path: runArtifacts.path })
    .from(runArtifacts)
    .where(and(eq(runArtifacts.swarmId, swarm.id), eq(runArtifacts.stageSlug, "document")))
    .orderBy(desc(runArtifacts.createdAt))
    .limit(1);

  const handle = await swarmSandboxHandle(ctx, swarm.sandboxId);
  const workspace = swarmWorkspaceKey(swarm.id);

  const body = swarmPullRequestBody({
    title: swarm.title,
    goal: swarm.goal,
    writeUp: design?.content ?? null,
    tasks,
    landedTaskIds: landedIds.map((row) => row.taskId),
    documentPath: document?.path ?? null,
  });
  const publishables: PublishableRepository[] = repoRows.map((row) => {
    const githubRepoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
    return {
      id: row.id,
      name: row.name,
      repoUrl: row.repoUrl,
      githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
      defaultBranch: row.defaultBranch,
      /**
       * Where the branch is read from, which is the one thing a swarm
       * publishes differently from a card.
       *
       * On a driver whose checkouts live on this host, the swarm's own
       * worktree is the branch: the merge queue fast forwards it, so it
       * holds every leaf that landed. On a driver that keeps the
       * repository inside the machine, the bundle has to come back out
       * of the swarm's sandbox, which is what exportRepository is for.
       */
      ...(handle && ctx.driver.exportRepository
        ? { exportBundle: () => ctx.driver.exportRepository!(handle, row.name, row.defaultBranch) }
        : { worktreePath: ctx.worktrees.worktreePath(workspace, row.name) }),
    };
  });

  const result = await publishSwarmBranches(
    ctx.db,
    publisher,
    { swarmId: swarm.id, title: swarm.title, body, branch, repositories: publishables },
    options,
  );

  for (const failure of result.failures) {
    // Logged rather than thrown: a repository that could not be
    // published does not undo the ones that were, and the job must not
    // be retried into opening the same pull requests again.
    console.error(`swarm ${swarm.id}: could not publish ${failure.name}: ${failure.reason}`);
  }
  if (result.published.length > 0) {
    ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id });
  }
  return { ...result, skipped: null };
}

/** The machine holding this swarm's checkouts, when one is recorded and alive. */
async function swarmSandboxHandle(ctx: AppContext, sandboxId: string | null): Promise<SandboxHandle | null> {
  if (!sandboxId) return null;
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  if (!row || row.status === "destroyed") return null;
  return { externalId: row.externalId, provider: row.provider, workdir: row.workdir };
}

/**
 * What the pull request says.
 *
 * A reviewer opening this has not watched the swarm, so the body has
 * to answer three questions in order: what was asked for, what the
 * planner decided, and what actually landed. The tree is the third
 * answer's shape rather than a flat list, because a swarm's leaves
 * only make sense under the plan node that grouped them.
 *
 * Every line that came from an agent or from the person who started
 * the swarm is written as text under a heading of its own, never
 * joined into a sentence of Bento's. Nothing here executes, so this is
 * legibility rather than safety, but a goal containing a heading
 * should read as part of the goal and not as a section of this body.
 */
export function swarmPullRequestBody(input: {
  title: string;
  goal: string;
  writeUp: string | null;
  tasks: (typeof swarmTasks.$inferSelect)[];
  landedTaskIds: string[];
  /** The assembled document, on a swarm whose deliverable is one. */
  documentPath?: string | null;
}): string {
  const lines: string[] = [`Opened by Bento for the swarm "${input.title}".`, ""];

  lines.push("## Goal", "", input.goal.trim() || "(none given)", "");

  /*
   * Named first, under the goal, on a swarm whose deliverable is a
   * document. It is the thing the reviewer is here to read, and the
   * sections underneath it are the working that produced it.
   */
  if (input.documentPath) {
    lines.push(
      "## The document",
      "",
      `This swarm's deliverable is a document. It is assembled from the sections below and committed at ${input.documentPath} on this branch.`,
      "",
    );
  }

  if (input.writeUp?.trim()) {
    lines.push("## What the planner wrote", "", input.writeUp.trim(), "");
  }

  const byParent = new Map<string | null, (typeof swarmTasks.$inferSelect)[]>();
  for (const task of input.tasks) {
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }
  const plan: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const task of byParent.get(parentId) ?? []) {
      plan.push(`${"  ".repeat(depth)}- ${task.title} (${task.status})`);
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  if (plan.length > 0) lines.push("## The plan", "", ...plan, "");

  const landed = new Set(input.landedTaskIds);
  const landedTasks = input.tasks.filter((task) => landed.has(task.id));
  lines.push("## What landed on this branch", "");
  if (landedTasks.length > 0) {
    lines.push(
      ...landedTasks.map((task) => `- ${task.title}`),
      "",
      "Each of those was worked on its own branch and landed onto this one through Bento's merge queue, one branch at a time.",
    );
  } else {
    lines.push("Nothing landed through the merge queue. The branch carries whatever the planner committed directly.");
  }

  return lines.join("\n");
}

/** This swarm's pull requests, newest write first, for the console's header. */
export async function swarmPullRequestRows(ctx: Pick<AppContext, "db">, swarmId: string) {
  return ctx.db
    .select({
      id: swarmPullRequests.id,
      repoUrl: swarmPullRequests.repoUrl,
      number: swarmPullRequests.number,
      url: swarmPullRequests.url,
      headSha: swarmPullRequests.headSha,
    })
    .from(swarmPullRequests)
    .where(eq(swarmPullRequests.swarmId, swarmId))
    .orderBy(asc(swarmPullRequests.createdAt));
}
