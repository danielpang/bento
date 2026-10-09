import { and, asc, eq } from "drizzle-orm";
import {
  repositories,
  sandboxes,
  swarmLandings,
  swarmTaskEvents,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { resolveRepositoryCommands } from "@bento/core";
import { collectExec, repositoryPathIn, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import { captureJobErrors } from "../../analytics.js";
import type { AppContext } from "../../context.js";
import { QUEUE_POLL_SECONDS } from "../queue.js";
import { landingPolicyFor, landingMergeMessage, workerBranchName } from "./branches.js";
import { handLeafToPlanner } from "./planner-news.js";
import { landWorkerBranch, landWorkerBundles, type LandOutcome } from "./landing-git.js";

/**
 * A landing outcome that stops the attempt.
 *
 * "empty" is excluded rather than handled below: a repository this
 * leaf did not touch is the normal case in a project spanning
 * several, and treating it as a failure would fail every landing of
 * every multi repository swarm.
 */
type LandFailure = Exclude<Extract<LandOutcome, { ok: false }>, { reason: "empty" }>;
import { SWARM_TICK_QUEUE, enqueueSwarmTick } from "./coordinator.js";
import { queueSwarmTaskSandboxReap } from "../reap-sandbox.js";
import { queueSwarmSlackNotify } from "../slack-notify.js";
import { swarmBranchName, swarmWorkspaceKey } from "./sandbox.js";
import { driverForSandbox } from "../sandbox-driver.js";
import { wakeSwarmSandbox } from "../hibernate-sandbox.js";

/**
 * The merge queue's other half: what actually happens when a landing
 * reaches the front.
 *
 * The queue itself is the coordinator's step four and a partial unique
 * index, and neither of them moves a byte of code. This is the part
 * that does, and everything here is arranged around one property:
 * running it twice on the same landing must leave the same result as
 * running it once. A landing is the only thing in a swarm that can
 * destroy work, and the job behind it is a pg-boss job, which means it
 * is retried, and which means the interesting case is the server dying
 * between the fast forward and the row that records it.
 *
 * So the order is: move the branch first, write the row second. The
 * branch move is a fast forward whose precondition is the commit the
 * landing was built on, so repeating it after a crash finds the work
 * already there and says so (landWorkerBranch answers "already an
 * ancestor" with a success and no commits), rather than applying it
 * again. A row written first and a branch moved second would have the
 * opposite failure, and it is the one that loses the work.
 */

/**
 * Why a landing failed, as a word the console picks its sentence and
 * its button from, and the analytics count by. The sentence in the
 * row's error is for people and changes; these do not.
 */
export const LANDING_FAILURE_CODES = [
  "no_repositories",
  "driver_unavailable",
  "checkout_failed",
  "swarm_sandbox_gone",
  "task_sandbox_gone",
  "transfer_unsupported",
  "wake_failed",
  "attempts_exhausted",
  "conflict_unresolved",
  "checks_failed",
  "checks_unavailable",
  "landing_error",
] as const;
export type LandingFailureCode = (typeof LANDING_FAILURE_CODES)[number];

/**
 * The failures that are about a machine and not about the work: the
 * branch is fine, Bento could not reach it or put it anywhere. These
 * are what error tracking is for, and what starting the task over in a
 * new machine can answer.
 */
export const SANDBOX_LANDING_FAILURES: ReadonlySet<LandingFailureCode> = new Set([
  "driver_unavailable",
  "swarm_sandbox_gone",
  "task_sandbox_gone",
  "transfer_unsupported",
  "wake_failed",
]);

/**
 * How long a landing sent back to the queue waits before it is
 * promoted again: thirty seconds, doubling, at most eight minutes. A
 * provider having a bad few minutes used to spend all five attempts in
 * the time one tick took to follow another.
 */
export function landingBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 8 * 60_000);
}

/** The queue one landing at a time goes through. */
export const SWARM_LAND_QUEUE = "swarm.land";

/**
 * How many times one landing may be tried before it is the planner's
 * problem rather than the queue's.
 *
 * A landing that cannot fast forward is asked to try again, because the
 * ordinary reason is that the swarm's branch moved and the next attempt
 * is built on the head it has now. Asked again without a count, it is a
 * loop: a tick and a land job and a handful of git subprocesses, as
 * fast as pg-boss will carry them, for as long as whatever is refusing
 * the fast forward keeps refusing it. The attempt column was already
 * being written and read by nothing, which is the same bug one column
 * further on.
 *
 * Five, because a real swarm lands one branch at a time and a branch
 * that genuinely moved under five consecutive attempts is not a race
 * any more.
 */
const MAX_LANDING_ATTEMPTS = 5;

/**
 * Which pg-boss instances already have a landing worker. Keyed by the
 * boss for the reason the tick worker's set is: the tests run many
 * contexts in one process, each with its own.
 */
const landWorkers = new WeakSet<object>();

/** What one landing did, for the log and for the tests. */
export interface LandingResult {
  landingId: string;
  status: (typeof swarmLandings.$inferSelect)["status"];
  /** Repositories whose swarm branch this landing moved. */
  landed: string[];
  /** The resolver run this landing started, when a conflict started one. */
  resolverRunId: string | null;
  reason: string | null;
}

/**
 * Starts the landing worker, if this process has not.
 *
 * Not at boot, for the reason the tick worker is not: most deployments
 * have never started a swarm, and a registered worker is a query per
 * poll forever. The ordinary poll interval rather than the interactive
 * one, because nobody is watching a landing the second it is queued:
 * the coordinator enqueues it as soon as it promotes the row, and the
 * poll is only the backstop for a job queued by a process that died.
 */
export async function ensureLandingWorker(ctx: AppContext): Promise<void> {
  if (landWorkers.has(ctx.boss)) return;
  landWorkers.add(ctx.boss);
  try {
    await ctx.boss.work<{ landingId: string }>(
      SWARM_LAND_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: QUEUE_POLL_SECONDS },
      captureJobErrors(ctx.analytics, SWARM_LAND_QUEUE, async (jobs) => {
        for (const job of jobs) await performLanding(ctx, job.data.landingId);
      }),
    );
  } catch (err) {
    landWorkers.delete(ctx.boss);
    throw err;
  }
}

/**
 * Asks for one landing to be performed.
 *
 * Called after the tick's transaction commits, never inside it: the
 * row has to say "landing" before a worker reads it, and a job sent
 * inside the transaction can be picked up before the commit lands.
 */
export async function enqueueLanding(ctx: AppContext, landingId: string): Promise<void> {
  await ensureLandingWorker(ctx);
  await ctx.boss.send(SWARM_LAND_QUEUE, { landingId }, { singletonKey: landingId });
}

/** Where a workspace's checkout of one repository is, on this host. */
function worktreeFor(ctx: AppContext, workspaceKey: string, repoName: string): string {
  return ctx.worktrees.worktreePath(workspaceKey, repoName);
}

export async function performLanding(ctx: AppContext, landingId: string): Promise<LandingResult | null> {
  const [landing] = await ctx.db.select().from(swarmLandings).where(eq(swarmLandings.id, landingId)).limit(1);
  if (!landing) return null;
  /**
   * Only a row the queue promoted. A job delivered twice, or delivered
   * after the landing already finished, finds the row in some other
   * status and stops: "landing" is the claim.
   *
   * The claim is not exclusive by itself, and the partial unique index
   * does not make it so: the index refuses a second row in flight for
   * one swarm, which is a different statement from refusing a second
   * job on one row. Two jobs for the same row is what a second machine
   * booting mid landing produces, through resumeClaimedLandings. So the
   * read here is only the cheap half; every outcome below writes with
   * the status it expects in the WHERE clause, and a write that matches
   * no row means somebody else finished this landing and this one says
   * nothing about it.
   */
  if (landing.status !== "landing") return null;

  const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, landing.taskId)).limit(1);
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, landing.swarmId)).limit(1);
  if (!task || !swarm || task.swarmId !== swarm.id) {
    return finish(ctx, landing, "cancelled", "the task this landing was for is gone.");
  }
  if (task.status === "cancelled") {
    return finish(ctx, landing, "cancelled", "the task was withdrawn while its branch waited to land.");
  }

  const repoRows = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, swarm.projectId))
    .orderBy(asc(repositories.position));
  if (repoRows.length === 0) {
    return finish(ctx, landing, "failed", "this project spans no repositories, so there is nothing to land.", undefined, "no_repositories");
  }
  const swarmBranch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const workerBranch = landing.branchName ?? task.branchName ?? workerBranchName(swarmBranch, task.id);
  const policy = landingPolicyFor(task);
  const swarmWorkspace = swarmWorkspaceKey(swarm.id);

  let landingDriver: SandboxDriver | null;
  try {
    landingDriver = await landingDriverFor(ctx, swarm.sandboxId);
  } catch (err) {
    return finish(
      ctx,
      landing,
      "failed",
      err instanceof Error ? err.message : "no driver configured on this server",
      task,
      "driver_unavailable",
    );
  }
  const clone = (landingDriver ?? ctx.drivers.default).workspace === "clone";
  if (!clone) {
    try {
      await ctx.worktrees.ensureAll(
        repoRows.map((repo) => ({ name: repo.name, localPath: repo.localPath, defaultBranch: repo.defaultBranch })),
        swarmWorkspace,
        swarmBranch,
      );
    } catch (error) {
      return finish(ctx, landing, "failed", `the swarm checkout could not be prepared: ${String(error)}`, task, "checkout_failed");
    }
  }

  const landed: string[] = [];
  const problems: { repo: string; outcome: LandFailure }[] = [];
  let remoteHandles: RemoteHandles | null = null;
  if (clone) {
    let found: Awaited<ReturnType<typeof landingSandboxHandles>>;
    try {
      found = await landingSandboxHandles(ctx, swarm, task);
    } catch (err) {
      if (err instanceof LandingWakeFailed) return wakeFailed(ctx, landing, task, err);
      return finish(
        ctx,
        landing,
        "failed",
        err instanceof Error ? err.message : "no driver configured on this server",
        task,
        "driver_unavailable",
      );
    }
    if ("missing" in found) {
      return finish(
        ctx,
        landing,
        "failed",
        found.missing === "swarm"
          ? "the swarm's sandbox is gone, so Bento has no copy of the swarm's branch to land this onto."
          : "this task's sandbox is gone, so Bento cannot read the branch that is waiting to land.",
        task,
        found.missing === "swarm" ? "swarm_sandbox_gone" : "task_sandbox_gone",
      );
    }
    if (!landingDriver?.exportRepository || !landingDriver.importRepository || !found.workerDriver.exportRepository) {
      return finish(
        ctx,
        landing,
        "failed",
        "this sandbox driver cannot transfer a reconciled branch back into the swarm sandbox.",
        task,
        "transfer_unsupported",
      );
    }
    remoteHandles = found;
  }
  for (const repo of repoRows) {
    /**
     * One repository at a time, and a failure in one stops the rest.
     *
     * A leaf that changed a frontend and a backend is one change, and
     * landing half of it would put the swarm's branch in a state
     * neither the worker nor the planner ever saw: the half that landed
     * cannot be taken back once the next landing has built on it. So
     * the first repository that cannot land ends the attempt, and the
     * retry starts again from the top, where the repositories that did
     * land read as "already an ancestor" and cost nothing.
     */
    const outcome = remoteHandles
      ? await landSandboxBranch({ swarm: landingDriver!, worker: remoteHandles.workerDriver }, {
          repoName: repo.name,
          baseBranch: repo.defaultBranch,
          swarmBranch,
          policy,
          mergeMessage: landingMergeMessage(task),
          swarmHandle: remoteHandles.swarm,
          workerHandle: remoteHandles.worker,
        })
      : await landWorkerBranch({
          repoPath: repo.localPath,
          swarmWorktree: worktreeFor(ctx, swarmWorkspace, repo.name),
          swarmBranch,
          workerBranch,
          policy,
          mergeMessage: landingMergeMessage(task),
          landingId: landing.id,
        });
    if (outcome.ok) {
      if (outcome.commits > 0) landed.push(repo.name);
      continue;
    }
    // A worker that committed nothing in this repository is the normal
    // case for a project spanning several: it is not a failure.
    if (outcome.reason === "empty") continue;
    problems.push({ repo: repo.name, outcome });
    break;
  }

  const problem = problems[0];
  if (!problem) {
    /**
     * The tests, and only now.
     *
     * After the fast forward, because what has to pass is the swarm's
     * branch with this leaf on it rather than the leaf's branch on its
     * own: a leaf that passes alone and breaks what landed before it is
     * exactly what a merge queue exists to catch. Inside the swarm's
     * sandbox, because the code being tested was written by an agent
     * and its test command would otherwise run on the server.
     */
    const check = await runLandingTests(ctx, swarm, repoRows, task);
    if (check.kind === "failed") return failTests(ctx, landing, task, swarm, check.detail);
    if (check.kind === "unavailable") return finish(ctx, landing, "failed", check.detail, task, "checks_unavailable");
    return succeed(ctx, landing, task, swarm, landed);
  }

  if (problem.outcome.reason === "moved") {
    /**
     * Nothing is wrong yet: the branch moved under this attempt, or
     * something held the lock on the checkout while it was being moved,
     * which is what the fast forward is there to notice. The row goes
     * back to the queue rather than to a person, and the next tick
     * promotes it again against the head it has now.
     *
     * Until it has been asked enough times. A retry with nothing
     * counting it is the loop this cap exists for, and a landing that
     * has spent five attempts being refused is no longer a race the
     * next attempt wins: it is something about this branch or this
     * checkout that a person or the planner has to look at.
     */
    if (landing.attempt >= MAX_LANDING_ATTEMPTS) {
      return finish(
        ctx,
        landing,
        "failed",
        [
          `${problem.repo}: this branch has been tried ${landing.attempt} times and the swarm's branch would not take it.`,
          "",
          problem.outcome.detail,
        ].join("\n"),
        task,
        "attempts_exhausted",
      );
    }
    return requeue(ctx, landing, problem.outcome.detail, landingBackoffMs(landing.attempt));
  }
  if (problem.outcome.reason === "conflict") {
    return conflicted(ctx, landing, task, swarm, `${problem.repo}: ${problem.outcome.detail}`);
  }
  return finish(ctx, landing, "failed", `${problem.repo}: ${problem.outcome.detail}`, task, "landing_error");
}

/** The two machines a remote landing reconciles, and the driver that owns the worker's. */
interface RemoteHandles {
  swarm: SandboxHandle;
  worker: SandboxHandle;
  workerDriver: SandboxDriver;
}

/** A hibernated machine this landing needed could not be started. */
class LandingWakeFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "LandingWakeFailed";
  }
}

/**
 * A machine that could not be started is usually the provider having
 * a bad minute, not something about this branch, so the landing goes
 * back to the queue and the next tick tries again, counted against the
 * same attempts a moved branch is. The provider's words go to the log
 * and to error tracking; the leaf, once the attempts are spent, gets a
 * sentence a person can act on.
 */
async function wakeFailed(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
  err: LandingWakeFailed,
): Promise<LandingResult | null> {
  console.warn(`landing ${landing.id} could not start a sandbox:`, err.cause ?? err);
  ctx.analytics?.captureException(err.cause ?? err, null, null, {
    source: "swarm_landing_wake",
    landing_id: landing.id,
    swarm_id: landing.swarmId,
  });
  if (landing.attempt < MAX_LANDING_ATTEMPTS) {
    return requeue(
      ctx,
      landing,
      "a sandbox holding this branch could not be started, so the landing will try again.",
      landingBackoffMs(landing.attempt),
    );
  }
  return finish(
    ctx,
    landing,
    "failed",
    `a sandbox holding this branch could not be started after ${landing.attempt} attempts.`,
    task,
    "wake_failed",
  );
}

/** The driver that owns the swarm's machine, when that machine is still there. */
async function landingDriverFor(ctx: AppContext, swarmSandboxId: string | null): Promise<SandboxDriver | null> {
  if (!swarmSandboxId) return null;
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarmSandboxId)).limit(1);
  if (!row || row.status === "destroyed") return null;
  return driverForSandbox(ctx.drivers, row);
}

/**
 * The two machines whose branches a remote landing reconciles, and
 * the driver that owns the worker's.
 *
 * The two need not share a provider. A worker whose sprite Fly could
 * not make is made on Modal under a sprite swarm, and what the landing
 * moves is a self contained bundle out of each machine and one back
 * into the swarm's, through this server: which machine wrote the
 * bytes never mattered to git. So the worker's driver is read from
 * the worker's own row, as the swarm's is from its own, and a landing
 * used to refuse here was a branch nobody could ever land.
 */
async function landingSandboxHandles(
  ctx: AppContext,
  swarm: typeof swarms.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
): Promise<RemoteHandles | { missing: "swarm" | "worker" }> {
  if (!swarm.sandboxId) return { missing: "swarm" };
  const [swarmSandbox] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId)).limit(1);
  const workerRows = await ctx.db.select().from(sandboxes).where(eq(sandboxes.swarmTaskId, task.id));
  const workerSandbox = workerRows.find((row) => row.status !== "destroyed");
  if (!swarmSandbox || swarmSandbox.status === "destroyed") return { missing: "swarm" };
  if (!workerSandbox) return { missing: "worker" };
  /**
   * A hibernated machine is still the branch, only asleep. A worker
   * whose report the planner took longer than the warm window to
   * accept is hibernated by the time its landing comes up, and a
   * landing retried by hand an hour later finds both machines that
   * way. So each is woken here, before either is exec'd into.
   */
  try {
    await Promise.all([
      wakeSwarmSandbox(ctx, swarmSandbox, swarm, swarm.plannerProfileId),
      wakeSwarmSandbox(ctx, workerSandbox, swarm, task.agentProfileId ?? swarm.workerProfileId),
    ]);
  } catch (err) {
    throw new LandingWakeFailed(err);
  }
  return {
    swarm: {
      externalId: swarmSandbox.externalId,
      provider: swarmSandbox.provider,
      workdir: swarmSandbox.workdir,
    },
    worker: {
      externalId: workerSandbox.externalId,
      provider: workerSandbox.provider,
      workdir: workerSandbox.workdir,
    },
    workerDriver: driverForSandbox(ctx.drivers, workerSandbox),
  };
}

/**
 * Lands one repository whose object stores live in two sandboxes.
 * Export and reconciliation do not move anything. The import is the
 * single compare-and-swap that changes the swarm branch.
 *
 * Each export goes through the driver that owns that machine, which
 * are two drivers when a worker fell back to Modal under a sprite
 * swarm; the import is always the swarm's.
 */
async function landSandboxBranch(
  drivers: { swarm: SandboxDriver; worker: SandboxDriver },
  input: {
    repoName: string;
    baseBranch: string;
    swarmBranch: string;
    policy: ReturnType<typeof landingPolicyFor>;
    mergeMessage: string;
    swarmHandle: SandboxHandle;
    workerHandle: SandboxHandle;
  },
): Promise<LandOutcome> {
  let swarmBundle;
  let workerBundle;
  try {
    [swarmBundle, workerBundle] = await Promise.all([
      drivers.swarm.exportRepository!(input.swarmHandle, input.repoName, input.baseBranch, { selfContained: true }),
      drivers.worker.exportRepository!(input.workerHandle, input.repoName, input.baseBranch, { selfContained: true }),
    ]);
  } catch (err) {
    return { ok: false, reason: "moved", detail: `could not export the sandbox branches: ${String(err)}` };
  }
  if (!swarmBundle || !workerBundle) {
    return { ok: false, reason: "error", detail: "a sandbox returned no snapshot for its checked out branch." };
  }

  const reconciled = await landWorkerBundles({
    swarm: swarmBundle,
    worker: workerBundle,
    policy: input.policy,
    mergeMessage: input.mergeMessage,
  });
  if (!reconciled.ok || !reconciled.bundle) return reconciled;

  let imported;
  try {
    imported = await drivers.swarm.importRepository!(
      input.swarmHandle,
      input.repoName,
      reconciled.bundle,
      { branch: input.swarmBranch, expectedHeadSha: reconciled.base },
    );
  } catch (err) {
    return { ok: false, reason: "moved", detail: `could not import the reconciled branch: ${String(err)}` };
  }
  if (!imported.ok) return imported;
  if (imported.headSha !== reconciled.head) {
    return {
      ok: false,
      reason: "error",
      detail: `the sandbox reported ${imported.headSha} after importing ${reconciled.head}.`,
    };
  }
  return { ok: true, base: reconciled.base, head: reconciled.head, commits: reconciled.commits };
}

/* ------------------------------------------------------------------ *
 * Test before landing.
 * ------------------------------------------------------------------ */

/**
 * Runs each repository's own check inside the swarm's sandbox.
 *
 * A configured check is a gate, so inability to execute it is distinct
 * from both a passing check and a project that configured no check.
 */
type LandingCheckResult =
  | { kind: "passed" | "not_configured" }
  | { kind: "failed" | "unavailable"; detail: string };

async function runLandingTests(
  ctx: AppContext,
  swarm: typeof swarms.$inferSelect,
  repoRows: (typeof repositories.$inferSelect)[],
  task: typeof swarmTasks.$inferSelect,
): Promise<LandingCheckResult> {
  const commands = repoRows
    .map((repo) => ({ name: repo.name, command: resolveRepositoryCommands(repo).testCommand?.trim() }))
    .filter((entry): entry is { name: string; command: string } => Boolean(entry.command));
  if (commands.length === 0) return { kind: "not_configured" };
  if (!swarm.sandboxId) {
    return {
      kind: "unavailable",
      detail: "the project has a landing check, but the swarm has no sandbox in which Bento can run it.",
    };
  }

  const [sandbox] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId)).limit(1);
  if (!sandbox || sandbox.status === "destroyed") {
    return {
      kind: "unavailable",
      detail: "the project has a landing check, but the swarm sandbox is unavailable, so Bento did not mark the landing successful.",
    };
  }
  const handle = { externalId: sandbox.externalId, provider: sandbox.provider, workdir: sandbox.workdir };
  let driver: SandboxDriver;
  try {
    driver = driverForSandbox(ctx.drivers, sandbox);
  } catch (err) {
    return {
      kind: "unavailable",
      detail: `the project has a landing check, but Bento could not run it in the swarm sandbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const entry of commands) {
    let result;
    try {
      result = await collectExec(
        driver.exec(handle, ["bash", "-lc", entry.command], {
          cwd: repositoryPathIn(sandbox.workdir, entry.name),
        }),
      );
    } catch (err) {
      return {
        kind: "unavailable",
        detail: `the project has a landing check, but Bento could not run it in the swarm sandbox: ${String(err)}`,
      };
    }
    if (result.exitCode === 0) continue;
    return {
      kind: "failed",
      detail: [
        `The swarm's branch does not pass ${entry.name}'s check with task ${task.id} on it.`,
        `Command: ${entry.command}`,
        "",
        tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
      ].join("\n"),
    };
  }
  return { kind: "passed" };
}

/** The last of a long output, which is where a test runner says what failed. */
function tail(text: string, limit = 8000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `... (earlier output trimmed)\n${trimmed.slice(-limit)}`;
}

/* ------------------------------------------------------------------ *
 * Outcomes.
 * ------------------------------------------------------------------ */

/**
 * Writes one landing's outcome, if this job is still the one holding
 * the row.
 *
 * Every outcome goes through here, because the status read at the top
 * of performLanding is only half a claim: two jobs can be carrying the
 * same row (a second machine booting while the first is mid landing is
 * all it takes), and the one that finishes second must not write its
 * answer over the first one's. The status this attempt read is part of
 * the WHERE clause, so the loser's update matches no row and it is told
 * so before it has touched the leaf, the queue, or the bus.
 */
async function claimOutcome(
  tx: LandingWriter,
  landing: typeof swarmLandings.$inferSelect,
  set: Partial<typeof swarmLandings.$inferInsert>,
): Promise<boolean> {
  const rows = await tx
    .update(swarmLandings)
    .set(set)
    .where(and(eq(swarmLandings.id, landing.id), eq(swarmLandings.status, landing.status)))
    .returning({ id: swarmLandings.id });
  return rows.length > 0;
}

/** The pool or a transaction on it, either of which can write the row. */
type LandingWriter = Pick<Db, "update" | "insert">;

async function succeed(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
  swarm: typeof swarms.$inferSelect,
  landed: string[],
): Promise<LandingResult | null> {
  const now = new Date();
  let claimed = false;
  await ctx.db.transaction(async (tx) => {
    claimed = await claimOutcome(tx, landing, { status: "landed", error: null, endedAt: now, updatedAt: now });
    if (!claimed) return;
    /**
     * The leaf is done now, and not when the planner accepted it.
     *
     * Accepting is a verdict on the work; this is the work being on the
     * swarm's branch, which is the only thing a later leaf, a pull
     * request, or a person reading the branch can see. A leaf marked
     * done at acceptance would have let a swarm read as finished with
     * branches still queued behind it.
     */
    await tx
      .update(swarmTasks)
      .set({ status: "done", attention: null, endedAt: task.endedAt ?? now, updatedAt: now })
      .where(eq(swarmTasks.id, task.id));
    await tx.insert(swarmTaskEvents).values({
      taskId: task.id,
      kind: "landed",
      fromStatus: task.status,
      toStatus: "done",
      detail: { repositories: landed, branch: landing.branchName ?? task.branchName },
    });
  });
  if (!claimed) return null;
  ctx.bus.emitBoardEvent({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: task.id,
    status: "done",
  });
  /**
   * The leaf's machine, now that its branch is on the swarm's branch.
   *
   * Here rather than at the next tick, because this is the moment the
   * machine stops being able to do anything: the branch it holds has
   * been landed, and a resumed worker would commit onto a branch the
   * merge queue has already taken. Queued rather than destroyed inline,
   * so a provider that is slow or down does not fail a landing that
   * has already succeeded.
   */
  await queueSwarmTaskSandboxReap(ctx, task.id);
  await queueSwarmSlackNotify(ctx, { type: "swarm_landed", swarmId: swarm.id, taskId: task.id });
  await enqueueSwarmTick(ctx, swarm.id);
  return { landingId: landing.id, status: "landed", landed, resolverRunId: null, reason: null };
}

/**
 * A landing whose tests failed.
 *
 * The leaf goes back to being worked, with the failure appended to the
 * planner's rejection channel, which is what the next worker on it
 * reads. The landing row is dropped rather than held: the branch that
 * failed is not the branch that will be tried next, so keeping its row
 * at the front of the queue would hold every other leaf behind work
 * that has to be redone first.
 *
 * The swarm's branch is left where the fast forward put it, and this is
 * the decision most worth arguing with. Rolling it back would be
 * cleaner, and it is not safe: between the fast forward and this line
 * another landing can have built on it, and a rollback would then
 * discard somebody else's landed work. Phase 2 lands one branch at a
 * time, so that window is small, and a swarm whose branch is failing
 * its own tests is a swarm whose next landing fails the same way and
 * whose planner is told each time.
 */
async function failTests(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
  swarm: typeof swarms.$inferSelect,
  failure: string,
): Promise<LandingResult | null> {
  const now = new Date();
  let claimed = false;
  await ctx.db.transaction(async (tx) => {
    claimed = await claimOutcome(tx, landing, {
      status: "failed",
      error: failure,
      errorCode: "checks_failed",
      endedAt: now,
      updatedAt: now,
    });
    if (!claimed) return;
    await handLeafToPlanner(tx, {
      task,
      status: "assigned",
      attention: "failed",
      set: { report: null },
      flags: {
        accepted: undefined,
        rejection: [
          "Your branch was accepted and landed onto the swarm's branch, and the swarm's branch then failed its checks.",
          "",
          failure,
        ].join("\n"),
      },
      detail: { landingFailed: failure },
      now,
    });
  });
  if (!claimed) return null;
  reportLandingFailure(ctx, landing, "checks_failed", failure);
  ctx.bus.emitBoardEvent({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: task.id,
    status: "assigned",
  });
  await enqueueSwarmTick(ctx, swarm.id);
  return { landingId: landing.id, status: "failed", landed: [], resolverRunId: null, reason: failure };
}

/**
 * A landing git could not do on its own.
 *
 * One resolver run, then the leaf fails. The retry is not a second
 * attempt at the same thing: the first resolver run works in the
 * leaf's own checkout, merges the swarm's branch into it, and resolves
 * by hand, and the landing that follows is a merge rather than a
 * rebase because the branch now contains the swarm's head. If that
 * still does not land, another agent looking at the same two versions
 * will not do better, and the leaf goes to the planner instead.
 *
 * The row stays "conflicted" while the resolver works, which is what
 * holds the queue: landing the branch behind a conflicted one would put
 * this leaf's work permanently out of order with the work that passed
 * it.
 *
 * The resolver itself is started by the tick, not here, and that is the
 * fix to a queue that used to stop for good. A start attempted here had
 * one chance: no worker agent on the swarm, a team at its plan
 * limit, or anything already running answered "no resolver", the row
 * stayed conflicted with nobody on it, and the tick skips a conflict
 * with no resolver rather than moving it. One conflict on a busy plan
 * and the swarm's whole queue was over. The tick is the reconciler, and
 * a conflicted row with no resolver is exactly the kind of fact it
 * exists to act on, every pass rather than once.
 */
async function conflicted(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
  swarm: typeof swarms.$inferSelect,
  detail: string,
): Promise<LandingResult | null> {
  const now = new Date();
  const alreadyTried = landing.resolverRunId !== null;
  let claimed = false;
  if (alreadyTried) {
    await ctx.db.transaction(async (tx) => {
      claimed = await claimOutcome(tx, landing, {
        status: "failed",
        error: detail,
        errorCode: "conflict_unresolved",
        endedAt: now,
        updatedAt: now,
      });
      if (!claimed) return;
      await handLeafToPlanner(tx, {
        task,
        status: "failed",
        attention: "conflict",
        flags: { conflict: detail },
        detail: { conflict: detail, resolverRunId: landing.resolverRunId },
        now,
      });
    });
    if (!claimed) return null;
    reportLandingFailure(ctx, landing, "conflict_unresolved", detail);
    ctx.bus.emitBoardEvent({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "failed",
    });
    await enqueueSwarmTick(ctx, swarm.id);
    return { landingId: landing.id, status: "failed", landed: [], resolverRunId: landing.resolverRunId, reason: detail };
  }

  await ctx.db.transaction(async (tx) => {
    claimed = await claimOutcome(tx, landing, { status: "conflicted", error: detail, updatedAt: now });
    if (!claimed) return;
    await tx
      .update(swarmTasks)
      .set({
        attention: "conflict",
        /**
         * The next landing of this leaf is a merge, not a rebase. The
         * resolver is about to put the swarm's branch inside the leaf's
         * branch; replaying the leaf's commits onto the swarm's branch
         * after that would ask git to resolve the same conflict again,
         * with the resolution already sitting in the history it is
         * replaying.
         */
        flags: { ...task.flags, conflict: detail, landPolicy: "merge" },
        updatedAt: now,
      })
      .where(eq(swarmTasks.id, task.id));
    await tx.insert(swarmTaskEvents).values({
      taskId: task.id,
      kind: "attention_raised",
      detail: { conflict: detail },
    });
  });
  if (!claimed) return null;
  ctx.bus.emitBoardEvent({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: task.id,
    status: task.status,
  });
  // The tick puts an agent on it, and is what tries again if it cannot.
  await enqueueSwarmTick(ctx, swarm.id);
  return { landingId: landing.id, status: "conflicted", landed: [], resolverRunId: null, reason: detail };
}

/** A landing that has to be tried again, with no blame attached. */
async function requeue(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  detail: string,
  /** How long to wait before it is promoted again. Absent: at once. */
  delayMs?: number,
): Promise<LandingResult | null> {
  const now = new Date();
  const notBefore = delayMs ? new Date(now.getTime() + delayMs) : null;
  const claimed = await claimOutcome(ctx.db, landing, {
    status: "queued",
    error: detail,
    startedAt: null,
    notBefore,
    updatedAt: now,
  });
  if (!claimed) return null;
  await enqueueSwarmTick(ctx, landing.swarmId);
  // And a tick for when the wait is over, under its own key so it does
  // not stand in for the ordinary ticks meanwhile.
  if (notBefore) {
    await ctx.boss.send(
      SWARM_TICK_QUEUE,
      { swarmId: landing.swarmId },
      { singletonKey: `${landing.swarmId}:landing-backoff`, startAfter: notBefore },
    );
  }
  return { landingId: landing.id, status: "queued", landed: [], resolverRunId: null, reason: detail };
}

/**
 * Every landing that ends failed is counted, and every one that is
 * about a machine rather than the work goes to error tracking.
 *
 * Before this a failed landing wrote its row and nothing else: the
 * swarm that lost its branch to a hibernated worker was found by a
 * person reading the board, not by an alert. Grouped by the code, so
 * one provider incident is one issue and not one per swarm.
 */
function reportLandingFailure(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  code: LandingFailureCode,
  reason: string,
): void {
  const properties = {
    swarm_id: landing.swarmId,
    swarm_task_id: landing.taskId,
    landing_id: landing.id,
    code,
    attempt: landing.attempt,
  };
  ctx.analytics?.capture({
    event: "swarm landing failed",
    organizationId: landing.organizationId,
    properties,
  });
  if (code === "checks_failed" || code === "conflict_unresolved") return;
  ctx.analytics?.captureException(new Error(`swarm landing failed: ${code}`), null, landing.organizationId, {
    ...properties,
    source: "swarm_landing",
    reason,
  });
}

/** Ends a landing with a status and a sentence, and tells the tree. */
async function finish(
  ctx: AppContext,
  landing: typeof swarmLandings.$inferSelect,
  status: "failed" | "cancelled",
  reason: string,
  task?: typeof swarmTasks.$inferSelect,
  code?: LandingFailureCode,
): Promise<LandingResult | null> {
  const now = new Date();
  const errorCode = status === "failed" ? (code ?? "landing_error") : null;
  let claimed = false;
  await ctx.db.transaction(async (tx) => {
    claimed = await claimOutcome(tx, landing, { status, error: reason, errorCode, endedAt: now, updatedAt: now });
    if (!claimed) return;
    if (!task || status !== "failed") return;
    await handLeafToPlanner(tx, {
      task,
      status: "failed",
      attention: "failed",
      flags: { landingError: reason, landingErrorCode: errorCode },
      detail: { landingError: reason, landingErrorCode: errorCode },
      now,
    });
  });
  if (!claimed) return null;
  if (errorCode) reportLandingFailure(ctx, landing, errorCode, reason);
  /**
   * A withdrawn leaf's machine, for the reason a landed one's is asked
   * for: the branch it holds is never going onto the swarm's branch, so
   * the machine is pure cost from here.
   *
   * Only for a withdrawal. A failed leaf is the planner's to reassign,
   * and its next worker provisions the same workspace, so reaping it
   * would be paying to tear down a machine we are about to rebuild.
   */
  if (status === "cancelled") await queueSwarmTaskSandboxReap(ctx, landing.taskId);
  await enqueueSwarmTick(ctx, landing.swarmId);
  return { landingId: landing.id, status, landed: [], resolverRunId: null, reason };
}

/**
 * Every landing a restart left claimed gets one job at boot.
 *
 * A row in "landing" with no process behind it is the one state the
 * queue cannot leave on its own: the index refuses a second row in
 * flight, so nothing else in that swarm can land until this one is
 * resolved. Re-running it is safe by construction, which is the whole
 * reason the branch is moved before the row is written.
 */
export async function resumeClaimedLandings(ctx: AppContext): Promise<number> {
  const claimed = await ctx.db
    .select({ id: swarmLandings.id })
    .from(swarmLandings)
    .where(eq(swarmLandings.status, "landing"));
  for (const row of claimed) await enqueueLanding(ctx, row.id);
  return claimed.length;
}
