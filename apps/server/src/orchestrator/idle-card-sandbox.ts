import { setTimeout as sleep } from "node:timers/promises";
import { and, asc, eq, gte, inArray, isNotNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { agentRuns, features, repositories, sandboxes } from "@bento/db";
import { parseRepoUrl, type GitHubPublisher } from "@bento/github";
import { collectExec, isExecTimeout, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { githubConnectionFor } from "../github.js";
import { SandboxGone, wakeSwarmSandbox } from "./hibernate-sandbox.js";
import { featureBranchLease, pushBranches, recordFeaturePush } from "./publish.js";
import { destroyAndConfirm } from "./reap-sandbox.js";
import { driverForSandbox, SandboxDriverUnavailable } from "./sandbox-driver.js";
import { SandboxInUse } from "./sandbox-usage.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/**
 * A card's sandbox goes once the card has sat this long with nothing
 * happening on it.
 *
 * A finished card's machine is reaped as it finishes. One that is still
 * on the board but that nobody has touched (a card parked in review, an
 * idea started and left) kept its sprite, or its Modal snapshot, for as
 * long as it stayed there, billed for storage and counted against the
 * sprite allowance. Five days is long enough that a card somebody is
 * still working on, over a weekend, keeps its machine.
 */
export const CARD_SANDBOX_IDLE_MS = 5 * 24 * 60 * 60 * 1000;

/** The message on the commit that saves what an agent left uncommitted. */
export const IDLE_WORK_COMMIT_MESSAGE = "Save uncommitted work before Bento released this card's idle sandbox";

/**
 * What a test puts in place of GitHub. Production passes nothing.
 */
export interface IdleCardPushOptions {
  publisher?: GitHubPublisher;
  remoteUrl?: (owner: string, repo: string) => string;
}

/**
 * The card's branch could not be put on GitHub, so its machine is still
 * the only copy of its work, and stays.
 */
export class CardBranchNotSaved extends Error {
  constructor(featureId: string, reason: string) {
    super(`card ${featureId}'s branch is not on GitHub: ${reason}`);
    this.name = "CardBranchNotSaved";
  }
}

/**
 * Releases the sandbox of every card left idle past CARD_SANDBOX_IDLE_MS.
 *
 * At boot and nightly, beside the finished card sweep. The query only
 * nominates: each card is read again, under its own lock, before any
 * machine goes.
 */
export async function reapIdleCardSandboxes(
  ctx: AppContext,
  options: { now?: Date; push?: IdleCardPushOptions } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - CARD_SANDBOX_IDLE_MS);
  const candidates = await ctx.db
    .selectDistinct({ featureId: sandboxes.featureId })
    .from(sandboxes)
    .innerJoin(features, eq(features.id, sandboxes.featureId))
    .where(
      and(
        ne(sandboxes.status, "destroyed"),
        // Done and cancelled cards are the finished card reaper's.
        notInArray(features.status, ["done", "cancelled"]),
        lt(sql`coalesce(${sandboxes.lastUsedAt}, ${sandboxes.updatedAt})`, cutoff),
      ),
    );
  for (const { featureId } of candidates) {
    if (!featureId) continue;
    try {
      await reapIdleCardSandbox(ctx, featureId, options);
    } catch (err) {
      // A machine somebody started using in between is the card being
      // used, not a failure; the next sweep asks again.
      if (err instanceof SandboxInUse) continue;
      console.warn(`could not release the idle sandbox of card ${featureId}:`, err);
      ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "card_idle_reap" });
    }
  }
}

/**
 * Releases one card's sandbox when the card has been idle long enough,
 * without losing anything on it. Answers whether the machine went.
 *
 * On a driver that clones inside its machine (a sprite, a Modal box)
 * the machine is often the only copy of the card's branch: a card
 * pushes only when it publishes. So first anything the agent left
 * uncommitted is committed, and the branch, Bento's stage write-ups
 * included, is pushed to GitHub under the lease a publish holds. The
 * commit is tried again when the exec fails before it ran (a refused
 * sandbox connection, including one the driver's own ladder gave up
 * on). A card that still cannot be saved (no GitHub connection, a
 * repository with no remote, a push GitHub refused, a commit that
 * exhausted those tries) keeps its machine: the reap does not idle it,
 * and the next boot or nightly sweep asks again. The next run on the
 * card makes a new machine from that branch (`cardRestoreBundles`), and
 * a later publish replaces it with the write-ups taken out.
 *
 * On a host driver (Docker, local) the machine is only a container: the
 * card's checkout is a worktree on this host, which stays where it is,
 * so nothing has to be saved and nothing on disk is removed.
 */
export async function reapIdleCardSandbox(
  ctx: AppContext,
  featureId: string,
  options: { now?: Date; push?: IdleCardPushOptions } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - CARD_SANDBOX_IDLE_MS);
  if (!(await cardIdleSince(ctx.db, featureId, cutoff))) return false;

  const rows = await liveCardSandboxes(ctx.db, featureId);
  if (rows.length === 0) return false;
  try {
    await saveCardBranch(ctx, featureId, rows, options.push ?? {});
  } catch (err) {
    // The destroy below is not reached. The machine stays the copy of
    // the branch until a later sweep manages to save it.
    if (!(err instanceof CardBranchNotSaved)) throw err;
    console.warn(`${err.message}; keeping its sandbox`);
    ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "card_idle_branch_unsaved" });
    return false;
  }

  /*
   * Under the card's lock, the one every run start takes
   * (startRunIfIdle), so no run can start on a machine that is going.
   * Read again, because saving can take minutes and a person can come
   * back to the card meanwhile. The rows are read again too: saving
   * wakes a hibernated machine, which moves its row to a new generation
   * and image, and a destroy of the row read before would leave the
   * woken machine running. A machine that is not one of those asked
   * about was made since, and stays.
   */
  const asked = new Set(rows.map((row) => row.id));
  return ctx.db.transaction(async (tx) => {
    await tx.select({ id: features.id }).from(features).where(eq(features.id, featureId)).for("update");
    if (!(await cardIdleSince(tx, featureId, cutoff))) {
      console.log(`card ${featureId} was used while its branch was being saved; keeping its sandbox`);
      return false;
    }
    const fresh = (await liveCardSandboxes(tx, featureId)).filter((row) => asked.has(row.id));
    let released = false;
    for (const row of fresh) {
      if (!(await destroyAndConfirm(ctx, row, `idle card ${featureId}`))) continue;
      await tx.update(sandboxes).set({ status: "destroyed" }).where(and(eq(sandboxes.id, row.id), eq(sandboxes.generation, row.generation)));
      console.log(`released sandbox ${row.externalId} of card ${featureId}, idle since before ${cutoff.toISOString()}`);
      released = true;
    }
    return released;
  });
}

/** Anything a read here goes through: the pool, or the reap's transaction. */
type Reader = Pick<AppContext["db"], "select">;

function liveCardSandboxes(db: Reader, featureId: string) {
  return db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")));
}

/**
 * Whether nothing has happened on the card since `cutoff`: it is still
 * on the board, no run is active or was queued or ended since, the card
 * was not changed since, and none of its machines was used since.
 */
async function cardIdleSince(db: Reader, featureId: string, cutoff: Date): Promise<boolean> {
  const [feature] = await db
    .select({ status: features.status, updatedAt: features.updatedAt })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!feature || feature.status === "done" || feature.status === "cancelled") return false;
  if (feature.updatedAt >= cutoff) return false;
  const [recent] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.featureId, featureId),
        or(
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
          gte(agentRuns.queuedAt, cutoff),
          and(isNotNull(agentRuns.endedAt), gte(agentRuns.endedAt, cutoff)),
        ),
      ),
    )
    .limit(1);
  if (recent) return false;
  const [used] = await db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.featureId, featureId),
        ne(sandboxes.status, "destroyed"),
        gte(sql`coalesce(${sandboxes.lastUsedAt}, ${sandboxes.updatedAt})`, cutoff),
      ),
    )
    .limit(1);
  return !used;
}

/**
 * Puts everything on a card's clone machines onto GitHub, or throws
 * CardBranchNotSaved. A machine on a host driver is not asked.
 */
async function saveCardBranch(
  ctx: AppContext,
  featureId: string,
  rows: (typeof sandboxes.$inferSelect)[],
  push: IdleCardPushOptions,
): Promise<void> {
  const clones: { row: typeof sandboxes.$inferSelect; driver: SandboxDriver }[] = [];
  for (const row of rows) {
    let driver: SandboxDriver;
    try {
      driver = driverForSandbox(ctx.drivers, row, ctx);
    } catch (err) {
      // This process cannot reach the machine, so it cannot destroy it
      // either; the destroy below says so and keeps the row.
      if (err instanceof SandboxDriverUnavailable) continue;
      throw err;
    }
    if (driver.workspace === "clone") clones.push({ row, driver });
  }
  if (clones.length === 0) return;

  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId)).limit(1);
  if (!feature) return;
  if (!feature.branchName) throw new CardBranchNotSaved(featureId, "the card has no branch name");
  const branch = feature.branchName;
  const publisher = push.publisher ?? (await githubConnectionFor(ctx, feature.organizationId));
  if (!publisher) throw new CardBranchNotSaved(featureId, "the organization has no GitHub connection");
  const repoRows = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, feature.projectId))
    .orderBy(asc(repositories.position));
  const remoteless = repoRows.filter((repo) => !repo.repoUrl || !parseRepoUrl(repo.repoUrl));
  if (remoteless.length > 0) {
    throw new CardBranchNotSaved(featureId, `${remoteless.map((repo) => repo.name).join(", ")} has no GitHub remote`);
  }
  // The agent the machine was made for, whose network a hibernated
  // machine is booted with.
  const [lastRun] = await ctx.db
    .select({ agentProfileId: agentRuns.agentProfileId })
    .from(agentRuns)
    .where(eq(agentRuns.featureId, featureId))
    .orderBy(sql`${agentRuns.queuedAt} desc`)
    .limit(1);

  for (const { row, driver } of clones) {
    if (!driver.exportRepository) throw new CardBranchNotSaved(featureId, `${driver.provider} cannot export a branch`);
    try {
      await wakeSwarmSandbox(ctx, row, { projectId: feature.projectId, organizationId: feature.organizationId }, lastRun?.agentProfileId ?? null);
    } catch (err) {
      // Gone already: whatever it held went with it, and the row now
      // says so. Anything else is a machine that could not be read.
      if (err instanceof SandboxGone) continue;
      throw new CardBranchNotSaved(featureId, `its sandbox could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
    const handle: SandboxHandle = { externalId: row.externalId, provider: driver.provider, workdir: row.workdir };
    for (const repo of repoRows) await commitLeftovers(featureId, driver, handle, repo.name);

    const outcome = await pushBranches(publisher, {
      branch,
      includeStageNotes: true,
      repositories: repoRows.map((repo) => {
        const githubRepoId = repo.githubRepoId ? Number(repo.githubRepoId) : undefined;
        return {
          id: repo.id,
          name: repo.name,
          repoUrl: repo.repoUrl,
          githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
          defaultBranch: repo.defaultBranch,
          exportBundle: () => driver.exportRepository!(handle, repo.name, repo.defaultBranch),
        };
      }),
      lease: (repo) => featureBranchLease(ctx.db, featureId, branch, repo.repoUrl),
      record: (repo, headSha) => recordFeaturePush(ctx.db, featureId, branch, repo.repoUrl, headSha),
      ...(push.remoteUrl ? { remoteUrl: push.remoteUrl } : {}),
    });
    if (outcome.failures.length > 0) {
      throw new CardBranchNotSaved(featureId, outcome.failures.map((f) => `${f.name}: ${f.reason}`).join("; "));
    }
  }
}

/**
 * How many times the commit exec is started.
 *
 * The sprite driver's handshake ladder already runs inside one exec.
 * These are further tries, for an exec that still ended without the
 * commit having run. A commit git itself refused is not one of them.
 */
export const IDLE_COMMIT_ATTEMPTS = 3;

/** Pauses between those tries. The driver's own ladder already waited. */
const IDLE_COMMIT_RETRY_DELAYS_MS = [2_000, 8_000];

/**
 * Bound on one commit exec.
 *
 * The sprite handshake ladder waits out several upgrades, and a lookup
 * that aborts is tried again inside that same exec. Two minutes is
 * shorter than one connect that never opens (two minutes on its own)
 * plus those waits, so the reap's timer could end a ladder that was
 * still retrying. Six minutes covers that and a git commit of a dirty
 * tree. A lookup that sits out the client's fifteen minute timeout is
 * still cut here, and the next attempt starts a fresh exec.
 */
const IDLE_COMMIT_TIMEOUT_MS = 6 * 60_000;

/**
 * Commits whatever the agent left uncommitted in one repository, so the
 * push carries it. A repository the machine has no checkout of has
 * nothing to commit. Hooks are skipped: the commit is Bento's, and a
 * hook that fails would keep the machine for good.
 *
 * The script is safe to run again. It commits only when the tree is
 * dirty, so a retry after a commit that landed but whose exit was lost
 * finds nothing to do.
 */
async function commitLeftovers(
  featureId: string,
  driver: SandboxDriver,
  handle: SandboxHandle,
  repoName: string,
): Promise<void> {
  const dir = `${handle.workdir}/${repoName}`;
  const script = [
    `cd ${shellQuote(dir)} 2>/dev/null || exit 0`,
    `[ -d .git ] || exit 0`,
    `if [ -n "$(git status --porcelain)" ]; then`,
    `  git add -A`,
    `  git -c user.name=Bento -c user.email=no-reply@usebento.ai commit --no-verify -q -m ${shellQuote(IDLE_WORK_COMMIT_MESSAGE)}`,
    `fi`,
  ].join("\n");
  let lastReason = "the commit did not finish";
  for (let attempt = 0; attempt < IDLE_COMMIT_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(IDLE_COMMIT_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const result = await collectExec(driver.exec(handle, ["sh", "-c", script], { timeoutMs: IDLE_COMMIT_TIMEOUT_MS }));
      if (result.exitCode === 0) return;
      lastReason = result.stderr.trim().split("\n").at(-1) || `exit code ${result.exitCode}`;
      if (!commitExecIsTransient(result)) break;
    } catch (err) {
      // A programming error, or a driver that refused for a reason
      // another try will not change, still fails the save. The reap
      // keeps the machine either way.
      if (!thrownExecIsTransient(err)) throw err;
      lastReason = err instanceof Error ? err.message : String(err);
    }
    if (attempt < IDLE_COMMIT_ATTEMPTS - 1) {
      console.warn(`card ${featureId}: committing uncommitted files in ${repoName} failed (${lastReason}); retrying`);
    }
  }
  throw new CardBranchNotSaved(featureId, `uncommitted files in ${repoName} could not be committed: ${lastReason}`);
}

/**
 * Whether another exec might commit what this one did not.
 *
 * A refused connection never started the script. A negative exit is
 * the socket, not git. The reap's own timeout counts only when the
 * output still says the connection was being retried, because that is
 * the ladder being cut off, and a git commit that simply ran long is
 * not. A machine that is gone is not tried again.
 */
function commitExecIsTransient(result: { exitCode: number; stderr: string; neverStarted?: "refused" | "gone" }): boolean {
  if (result.neverStarted === "gone") return false;
  if (result.neverStarted === "refused") return true;
  if (result.exitCode < 0 && !isExecTimeout(result.stderr)) return true;
  return (
    isExecTimeout(result.stderr) &&
    /did not accept the exec connection|non-101 status code|aborted due to timeout/i.test(result.stderr)
  );
}

/** A throw from exec, before a stream, that is the same transport failure. */
function thrownExecIsTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /aborted due to timeout|non-101 status code|WebSocket error|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|did not accept the exec connection/i.test(
    err.message,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
