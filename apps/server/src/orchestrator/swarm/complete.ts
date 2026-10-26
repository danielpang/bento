import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  repositories,
  runArtifacts,
  sandboxes,
  swarmLandings,
  swarmPullRequests,
  swarmTasks,
  swarms,
} from "@bento/db";
import { parseRepoUrl, type GitHubPublisher } from "@bento/github";
import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { githubConnectionFor } from "../../github.js";
import { SWARM_DESIGN_PATH } from "./design-document.js";
import { hostBranchSource, publishSwarmBranches, type PublishableRepository, type PublishedPullRequest } from "../publish.js";
import { swarmBranchName, swarmWorkspaceKey } from "./sandbox.js";
import { workerBranchName } from "./branches.js";
import { pushSwarmBranch } from "./remote-branches.js";
import { driverForSandbox } from "../sandbox-driver.js";
import { SandboxGone, wakeSwarmSandbox } from "../hibernate-sandbox.js";

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

/** What one publish did, for the person who asked and for the tests. */
export interface SwarmPublishResult {
  published: PublishedPullRequest[];
  failures: { name: string; reason: string }[];
  /** Why nothing was attempted, when nothing was. */
  skipped: string | null;
  /**
   * The machine was lost after a task landed and before that landing
   * reached GitHub, so the pull request was opened over a branch that
   * is missing it. Never true when Bento reaped the machine, which it
   * does only once GitHub has the branch.
   */
  behind?: boolean;
}

/**
 * The two ways a finished swarm becomes pull requests, which a person
 * picks once the swarm is done: one pull request of the swarm's branch,
 * every task merged in the order it landed, or one per task, stacked,
 * each against the task that landed before it.
 */
export type SwarmPublishMode = "combined" | "stacked";

/**
 * Pushes a finished swarm's branch and opens its pull requests.
 *
 * Safe to run twice, which is what a second click is: the rows are
 * an upsert keyed by swarm and repository, and `ensurePullRequest`
 * finds the pull request it opened the first time rather than opening
 * a second.
 */
export async function publishFinishedSwarm(
  ctx: AppContext,
  swarmId: string,
  mode: SwarmPublishMode = "combined",
): Promise<SwarmPublishResult | null> {
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId)).limit(1);
  if (!swarm) return null;
  /**
   * A person may publish at any point once something landed, so the
   * work is on GitHub before the sandbox holding it can be reaped. A
   * pull request opened mid swarm is over an unfinished change, which
   * is what the person asked for.
   */
  const [landed] = await ctx.db
    .select({ id: swarmLandings.id })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.status, "landed")))
    .limit(1);
  if (!landed) {
    return { published: [], failures: [], skipped: "nothing has been committed to the swarm's branch yet" };
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
  return mode === "stacked"
    ? publishStackedPullRequests(ctx, swarm, publisher)
    : publishSwarmCompletion(ctx, swarm, publisher);
}

type StackFlags = {
  landedHeads?: Record<string, string>;
  pushedHeads?: Record<string, string>;
  pullRequests?: Record<string, { number: number; url: string }>;
};

/**
 * One pull request per landed task, each against the one before it.
 *
 * Every landing pushed the task's branch as the swarm's head at that
 * moment, so task N's branch is task N-1's plus task N, and a pull
 * request of N against N-1 shows exactly what task N changed. Merging
 * them bottom up merges the swarm. A repository a task did not touch
 * is not part of that repository's stack.
 *
 * A landed branch whose push never happened is pushed first, from the
 * swarm's machine, so a stack is never opened against a branch GitHub
 * does not have. Safe to run twice: ensurePullRequest finds the pull
 * request it opened the first time.
 */
export async function publishStackedPullRequests(
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
  const order = await ctx.db
    .select({ taskId: swarmLandings.taskId })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.status, "landed")))
    .orderBy(asc(swarmLandings.endedAt));
  const landedTasks = [];
  for (const { taskId } of order) {
    const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)).limit(1);
    if (task && Object.keys((task.flags as StackFlags).landedHeads ?? {}).length > 0) landedTasks.push(task);
  }
  if (landedTasks.length === 0) {
    return { published: [], failures: [], skipped: "no task was merged with changes, so there is nothing to stack" };
  }

  const swarmBranch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const published: PublishedPullRequest[] = [];
  const failures: { name: string; reason: string }[] = [];

  // Anything landed and not yet on GitHub goes there first.
  for (const task of landedTasks) {
    const flags = task.flags as StackFlags;
    const missing = repoRows.some(
      (repo) => repo.repoUrl && flags.landedHeads?.[repo.name] && !flags.pushedHeads?.[repo.repoUrl],
    );
    if (missing) await pushSwarmBranch(ctx, swarm.id, task.id, { publisher, ...options });
  }

  for (const repo of repoRows) {
    const parsed = repo.repoUrl ? parseRepoUrl(repo.repoUrl) : null;
    if (!repo.repoUrl || !parsed) continue;
    const inThisRepo = [];
    for (const original of landedTasks) {
      const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, original.id)).limit(1);
      if (task && (task.flags as StackFlags).landedHeads?.[repo.name]) inThisRepo.push(task);
    }
    let base = repo.defaultBranch;
    for (const [index, task] of inThisRepo.entries()) {
      const head = task.branchName ?? workerBranchName(swarmBranch, task.id);
      try {
        const pr = await publisher.ensurePullRequest({
          owner: parsed.owner,
          repo: parsed.repo,
          head,
          base,
          title: task.title,
          body: stackedPullRequestBody({ swarm, task, index, total: inThisRepo.length, base }),
        });
        await ctx.db
          .update(swarmTasks)
          .set({
            flags: sql`jsonb_set(coalesce(${swarmTasks.flags}, '{}'::jsonb), '{pullRequests}', coalesce(${swarmTasks.flags}->'pullRequests', '{}'::jsonb) || ${JSON.stringify({ [repo.repoUrl]: { number: pr.prNumber, url: pr.url } })}::jsonb)`,
          })
          .where(eq(swarmTasks.id, task.id));
        published.push({ name: repo.name, repoUrl: repo.repoUrl, prNumber: pr.prNumber, url: pr.url });
      } catch (err) {
        // The rest of the stack sits on this one, so it stops here.
        failures.push({ name: `${repo.name} (${task.title})`, reason: err instanceof Error ? err.message : String(err) });
        break;
      }
      base = head;
    }
  }
  for (const failure of failures) console.error(`swarm ${swarm.id}: could not open a stacked pull request for ${failure.name}: ${failure.reason}`);
  if (published.length > 0) {
    ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id });
  }
  return { published, failures, skipped: null };
}

function stackedPullRequestBody(input: {
  swarm: typeof swarms.$inferSelect;
  task: typeof swarmTasks.$inferSelect;
  index: number;
  total: number;
  base: string;
}): string {
  const lines = [
    `Part ${input.index + 1} of ${input.total} of the swarm "${input.swarm.title}".`,
    "",
    input.index === 0
      ? `This is the bottom of the stack. Merge it first, then the next part.`
      : `Stacked on \`${input.base}\`: this shows only this task's changes. Merge the parts below it first.`,
  ];
  if (input.task.description.trim()) lines.push("", "## Task", "", input.task.description.trim());
  if (input.task.report?.trim()) lines.push("", "## What the agent reported", "", input.task.report.trim());
  return lines.join("\n");
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
  const located = await swarmSandbox(ctx, swarm);
  const handle = located?.handle ?? null;
  const publishDriver = located?.driver ?? null;
  const workspace = swarmWorkspaceKey(swarm.id);
  const body = await combinedPullRequestBody(ctx, swarm);
  // Unfinished work opens as a draft, so nobody merges half a swarm.
  const draft = swarm.status !== "done";

  /*
   * The machine is gone, so there is no checkout to push from. Every
   * landing already pushed the swarm's branch, so the pull request is
   * opened on what GitHub holds.
   */
  if (!located && ctx.drivers.default.workspace === "clone") {
    const result = await publishPushedSwarmBranch(ctx, swarm, publisher, repoRows, branch, body, draft);
    await refreshSwarmPullRequests(ctx, swarm.id, publisher);
    return result;
  }
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
      ...(handle && publishDriver?.exportRepository
        ? { exportBundle: () => publishDriver.exportRepository!(handle, row.name, row.defaultBranch) }
        : hostBranchSource(ctx.worktrees.worktreePath(workspace, row.name), row, branch)),
    };
  });

  const result = await publishSwarmBranches(
    ctx.db,
    publisher,
    { swarmId: swarm.id, title: swarm.title, body, branch, repositories: publishables, draft },
    options,
  );
  // An open pull request is found rather than opened, and keeps its old text without this.
  await refreshSwarmPullRequests(ctx, swarm.id, publisher);

  for (const failure of result.failures) {
    // Returned rather than thrown: a repository that could not be
    // published does not undo the ones that were.
    console.error(`swarm ${swarm.id}: could not publish ${failure.name}: ${failure.reason}`);
  }
  if (result.published.length > 0) {
    ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id });
  }
  return { ...result, skipped: null };
}

/**
 * The machine holding this swarm's checkouts, woken when it is
 * hibernated (a swarm can be published mid run, between turns), or
 * null when none is recorded or it is gone.
 */
async function swarmSandbox(
  ctx: AppContext,
  swarm: typeof swarms.$inferSelect,
): Promise<{ handle: SandboxHandle; driver: SandboxDriver } | null> {
  if (!swarm.sandboxId) return null;
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId)).limit(1);
  if (!row || row.status === "destroyed") return null;
  const driver = driverForSandbox(ctx.drivers, row, ctx);
  if (driver.workspace === "clone") {
    try {
      await wakeSwarmSandbox(ctx, row, swarm, swarm.plannerProfileId);
    } catch (err) {
      if (err instanceof SandboxGone) return null;
      throw err;
    }
  }
  return {
    handle: { externalId: row.externalId, provider: row.provider, workdir: row.workdir },
    driver,
  };
}

/** A combined pull request over the swarm's branch as Bento last pushed it. */
async function publishPushedSwarmBranch(
  ctx: AppContext,
  swarm: typeof swarms.$inferSelect,
  publisher: GitHubPublisher,
  repoRows: (typeof repositories.$inferSelect)[],
  branch: string,
  body: string,
  draft: boolean,
): Promise<SwarmPublishResult> {
  const published: PublishedPullRequest[] = [];
  const failures: { name: string; reason: string }[] = [];
  const [last] = await ctx.db
    .select({ endedAt: swarmLandings.endedAt })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.status, "landed")))
    .orderBy(desc(swarmLandings.endedAt))
    .limit(1);
  const behind = Boolean(last?.endedAt && (!swarm.branchPushedAt || swarm.branchPushedAt < last.endedAt));
  if (behind) {
    ctx.analytics?.captureException(
      new Error(`swarm ${swarm.id}: its machine is gone and GitHub's copy of its branch predates its last landing`),
      null,
      swarm.organizationId,
      { swarm_id: swarm.id, source: "swarm_branch_behind" },
    );
  }
  for (const repo of repoRows) {
    const headSha = repo.repoUrl ? swarm.pushedHeads?.[repo.repoUrl] : undefined;
    const parsed = repo.repoUrl ? parseRepoUrl(repo.repoUrl) : null;
    if (!repo.repoUrl || !headSha || !parsed) continue;
    try {
      const pr = await publisher.ensurePullRequest({
        owner: parsed.owner,
        repo: parsed.repo,
        head: branch,
        base: repo.defaultBranch,
        title: swarm.title,
        body,
        draft,
      });
      await ctx.db
        .insert(swarmPullRequests)
        .values({ swarmId: swarm.id, repositoryId: repo.id, repoUrl: repo.repoUrl, number: pr.prNumber, url: pr.url, headSha })
        .onConflictDoUpdate({
          target: [swarmPullRequests.swarmId, swarmPullRequests.repoUrl],
          set: { number: pr.prNumber, url: pr.url, headSha, updatedAt: new Date() },
        });
      published.push({ name: repo.name, repoUrl: repo.repoUrl, prNumber: pr.prNumber, url: pr.url });
    } catch (err) {
      failures.push({ name: repo.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const failure of failures) console.error(`swarm ${swarm.id}: could not publish ${failure.name}: ${failure.reason}`);
  if (published.length > 0) {
    ctx.bus.emitBoardEvent({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id });
  }
  const skipped = published.length === 0 && failures.length === 0
    ? "the swarm's sandbox is gone and its branch was never pushed to GitHub"
    : null;
  return { published, failures, skipped, behind };
}

async function combinedPullRequestBody(ctx: AppContext, swarm: typeof swarms.$inferSelect): Promise<string> {
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
  return swarmPullRequestBody({
    title: swarm.title,
    goal: swarm.goal,
    writeUp: design?.content ?? null,
    tasks,
    landedTaskIds: landedIds.map((row) => row.taskId),
    documentPath: document?.path ?? null,
  });
}

/**
 * Rewrites the swarm's combined pull requests to say what is on the
 * branch now, and takes them out of draft once the swarm is done. Run
 * after every push of the swarm's branch, so a pull request opened
 * mid swarm does not keep the task list it was opened with. Best
 * effort: a pull request GitHub will not update is logged, never
 * thrown, because the push it follows already happened.
 */
export async function refreshSwarmPullRequests(
  ctx: AppContext,
  swarmId: string,
  publisher: GitHubPublisher,
): Promise<void> {
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId)).limit(1);
  if (!swarm) return;
  const rows = await ctx.db.select().from(swarmPullRequests).where(eq(swarmPullRequests.swarmId, swarm.id));
  if (rows.length === 0) return;
  const body = await combinedPullRequestBody(ctx, swarm);
  for (const row of rows) {
    const parsed = parseRepoUrl(row.repoUrl);
    if (!parsed) continue;
    const ref = { owner: parsed.owner, repo: parsed.repo, prNumber: row.number };
    try {
      await publisher.updatePullRequest({ ...ref, title: swarm.title, body });
      if (swarm.status === "done") await publisher.markPullRequestReady?.(ref);
    } catch (err) {
      console.error(`swarm ${swarm.id}: could not refresh pull request ${row.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  lines.push("## What was merged into this branch", "");
  if (landedTasks.length > 0) {
    lines.push(
      ...landedTasks.map((task) => `- ${task.title}`),
      "",
      "Each of those was worked on its own branch and merged into this one through Bento's merge queue, one branch at a time.",
    );
  } else {
    lines.push("Nothing was merged through the merge queue. The branch carries whatever the planner committed directly.");
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
