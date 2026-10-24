import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { messageAttachments, writeMessageAttachments } from "../message-attachments.js";
import { z } from "zod";
import { parentDeleteRefusal } from "@bento/core";
import {
  agentProfiles,
  agentRuns,
  featureEvents,
  featureMessages,
  featurePullRequests,
  runArtifacts,
  runEvents,
  features,
  gateChecks,
  pipelines,
  repositories,
  sandboxes,
  user,
} from "@bento/db";
import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { deferAfterCommit, respondAfterCommit, tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { canAccessProject, getAccessibleFeature } from "../access.js";
import { driverForSandbox, SandboxDriverUnavailable } from "../orchestrator/sandbox-driver.js";
import { childCount, parentRefusal, relatedGroup } from "../feature-tree.js";
import { getBetaTester, runsForCaller } from "../feature-flags.js";
import {
  advanceFeature,
  evaluateFeatureGate,
  finishFeature,
  moveFeatureBack,
  moveFeatureTo,
  recordManualApproval,
  recordRejection,
  reopenFeature,
  activationRefusal,
} from "../orchestrator/gate-evaluator.js";
import { ACTIVE_RUN_STATUSES, CARD_BUSY_DELETE, NO_REPOSITORIES, projectHasRepositories, startRunIfIdle } from "../orchestrator/start-run.js";
import { enqueueRun } from "../orchestrator/queue.js";
import { liveDeliveryOf, nudgeAndAwaitSent } from "../orchestrator/remote-live.js";
import { queueLinearIssueCreate } from "../orchestrator/linear-sync.js";
import {
  claimQueuedMessages,
  enqueueMessage,
  markMessagesDelivered,
  requeueMessages,
} from "../orchestrator/messages.js";
import { latestConversationRun, resolveFollowUpRun } from "../orchestrator/stage-agent.js";
import { asPipelineRun } from "../orchestrator/pipeline-run.js";
import { buildCiFixPrompt, buildConflictResolutionPrompt, buildRebaseForPublishPrompt } from "../orchestrator/prompt.js";
import { publishFeatureBranches, type PublishableRepository } from "../orchestrator/publish.js";
import { applyPendingPullRequestUpdates } from "../orchestrator/pull-request-updates.js";
import { startFeatureFollowUpRun, startFeatureRebaseRun, recoverAncestryPublishFailures, type RebaseTarget } from "../orchestrator/rebase-run.js";
import { linkGitHubRemotes } from "../orchestrator/repo-remote.js";
import { parseRepoUrl, type GitHubClient, type GitHubPublisher } from "@bento/github";
import { githubConnectionFor } from "../github.js";
import {
  featurePullRequestHistory,
  featurePullRequestTargets,
  pullRequestStateOf,
  type FeaturePullRequestRecord,
  type FeaturePullRequestTarget,
} from "../feature-prs.js";
import { shouldIncludeStageNotes } from "../settings.js";
import { collectFeatureChanges } from "../feature-changes.js";

const createFeature = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().default(""),
  /**
   * The card this one was split out of. Optional and rare: it is how a
   * person, the TUI, or the agent-facing MCP tool files one part of a
   * task that was judged too large for a single branch.
   */
  parentId: z.string().uuid().optional(),
});

/**
 * The card's own log, with the person who moved it when a person did.
 * The join is here so every history reader names them the same way.
 */
function featureHistory(c: Parameters<typeof db>[0], ctx: AppContext, featureId: string) {
  return db(c, ctx)
    .select({
      event: featureEvents,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(featureEvents)
    .leftJoin(user, eq(user.id, featureEvents.actorUserId))
    .where(eq(featureEvents.featureId, featureId))
    .orderBy(asc(featureEvents.at));
}

/**
 * Attaches the first pull request's URL to each card.
 *
 * `features.pr_number` alone gave clients an identifier with no route
 * to the thing it names, so the only clickable link lived in a run's
 * transcript and disappeared with it. The number keeps mirroring the
 * first repository's; this is that same row's address.
 */
async function withPullRequestUrls<T extends { id: string; prNumber: number | null }>(
  c: Parameters<typeof db>[0],
  ctx: AppContext,
  rows: T[],
): Promise<(T & { prUrl: string | null })[]> {
  const wanted = rows.filter((row) => row.prNumber !== null).map((row) => row.id);
  if (wanted.length === 0) return rows.map((row) => ({ ...row, prUrl: null }));
  const prs = await db(c, ctx)
    .select()
    .from(featurePullRequests)
    .where(inArray(featurePullRequests.featureId, wanted))
    .orderBy(asc(featurePullRequests.createdAt));
  /**
   * Matched on the number the card mirrors, not on the oldest row. A
   * card keeps a row per branch it has published from, so "the first
   * one" is the pull request of a branch it may have left behind, and
   * the link under a card has to be the link to the number beside it.
   *
   * First match wins, and the oldest row is still the fallback. Pull
   * request numbers are per repository, so a card spanning two can
   * hold two rows numbered the same and only the earlier one is the
   * mirrored repository's; and a number that matches no row at all
   * (linked by hand) kept its link before this and keeps it now.
   */
  const byNumber = new Map<string, string>();
  const oldest = new Map<string, string>();
  for (const pr of prs) {
    const owner = rows.find((row) => row.id === pr.featureId);
    if (!owner) continue;
    if (!oldest.has(pr.featureId)) oldest.set(pr.featureId, pr.url);
    if (owner.prNumber === pr.number && !byNumber.has(pr.featureId)) byNumber.set(pr.featureId, pr.url);
  }
  return rows.map((row) => ({ ...row, prUrl: byNumber.get(row.id) ?? oldest.get(row.id) ?? null }));
}

/** "acme/api" from a GitHub address, for a repository no longer in the project. */
function repoNameFromUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, "").split("/").slice(-2).join("/") || repoUrl;
}

/**
 * What every door without a GitHub connection says, once. Two routes
 * refusing with two drifting copies of these instructions is how one of
 * them ends up pointing at a Settings panel that moved.
 */
const GITHUB_NOT_CONNECTED =
  "no GitHub connection is configured. Save a GitHub token under Settings, GitHub, or install the GitHub App, then try again.";

interface PullRequestMergeRow {
  name: string;
  number: number;
  url: string;
  defaultBranch: string;
  /**
   * "conflicted" is the only state that asks for anything; it also
   * implies the pull request is still open, because a closed or merged
   * one answers "unknown". "unknown" covers everything that cannot be
   * read: no GitHub connection, a non-GitHub remote, GitHub still
   * computing mergeability, or the API refusing the read.
   */
  state: "clean" | "conflicted" | "unknown";
}

interface PullRequestCheckRow {
  name: string;
  number: number;
  url: string;
  /**
   * "failed" when GitHub reports at least one failing check on the pull
   * request head. "pending" when checks are still running. "passed" when
   * every check succeeded or none are configured. "unknown" covers every
   * unreadable case, same as merge-status.
   */
  state: "passed" | "pending" | "failed" | "unknown";
}

/**
 * A slow GitHub answer must not hold this request open indefinitely:
 * in multi mode the whole handler runs inside the tenant transaction,
 * so every second spent waiting is a pooled connection doing nothing.
 * Past the bound the state is "unknown", which the caller already
 * treats as "ask again later".
 */
const MERGE_STATE_TIMEOUT_MS = 8000;

/**
 * Asks GitHub where each pull request stands against its base. One
 * failing read does not spoil the others: a card spanning several
 * repositories still learns about the conflicts GitHub could report.
 */
async function readMergeStates(
  connection: (GitHubClient & GitHubPublisher) | undefined,
  rows: FeaturePullRequestTarget[],
): Promise<PullRequestMergeRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      const base: Omit<PullRequestMergeRow, "state"> = {
        name: row.name ?? repoNameFromUrl(row.repoUrl),
        number: row.number,
        url: row.url,
        defaultBranch: row.defaultBranch ?? "main",
      };
      const parsed = parseRepoUrl(row.repoUrl);
      if (!connection?.mergeState || !parsed) return { ...base, state: "unknown" };
      try {
        const summary = await boundedRead(
          connection.mergeState({ owner: parsed.owner, repo: parsed.repo, prNumber: row.number }),
        );
        return { ...base, state: summary.state };
      } catch {
        return { ...base, state: "unknown" };
      }
    }),
  );
}

interface PullRequestStateRow {
  number: number;
  url: string;
  /**
   * "merged" only when GitHub says the branch landed. "closed" is a
   * pull request someone closed without merging, whose work never
   * shipped, so the two are never shown as the same thing. "unknown"
   * covers every unreadable case, same as merge-status.
   */
  state: "merged" | "open" | "closed" | "unknown";
}

/**
 * Asks GitHub how each pull request ended. One failing read does not
 * spoil the others, and a card with no GitHub connection still lists
 * what it opened, marked unknown.
 */
async function readPullRequestStates(
  connection: (GitHubClient & GitHubPublisher) | undefined,
  rows: FeaturePullRequestRecord[],
): Promise<PullRequestStateRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      const base = { number: row.number, url: row.url };
      const parsed = parseRepoUrl(row.repoUrl);
      if (!connection || !parsed) return { ...base, state: "unknown" as const };
      try {
        const pr = await boundedRead(
          connection.getPullRequest({ owner: parsed.owner, repo: parsed.repo, prNumber: row.number }),
        );
        return { ...base, state: pullRequestStateOf(pr) };
      } catch {
        return { ...base, state: "unknown" as const };
      }
    }),
  );
}

/**
 * Asks GitHub how CI checks on each pull request head are doing. One
 * failing read does not spoil the others.
 */
async function readCheckStates(
  connection: (GitHubClient & GitHubPublisher) | undefined,
  rows: FeaturePullRequestTarget[],
): Promise<PullRequestCheckRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      const base: Omit<PullRequestCheckRow, "state"> = {
        name: row.name ?? repoNameFromUrl(row.repoUrl),
        number: row.number,
        url: row.url,
      };
      const parsed = parseRepoUrl(row.repoUrl);
      if (!connection || !parsed) return { ...base, state: "unknown" };
      try {
        const checks = await boundedRead(
          connection.checks({ owner: parsed.owner, repo: parsed.repo, prNumber: row.number }),
        );
        if (checks.failed > 0) return { ...base, state: "failed" };
        if (checks.pending > 0) return { ...base, state: "pending" };
        return { ...base, state: "passed" };
      } catch {
        return { ...base, state: "unknown" };
      }
    }),
  );
}

/** The timer is cleared on the fast path so it cannot outlive the request. */
async function boundedRead<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("merge state read timed out")), MERGE_STATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Carries a failed sandbox destroy out of the delete's transaction.
 *
 * Thrown rather than returned because the transaction has to roll back
 * with it: a card whose row is gone while its machine keeps running is
 * a billed sandbox no query in this product can find again.
 */
class SandboxDestroyFailed extends Error {
  /** A missing driver will fail the same way on every retry. */
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

/**
 * How many of a finished run's last events the conversation route
 * returns per run. Enough for a whole ordinary run; a long one shows
 * its tail and offers the rest on demand.
 */
export const CONVERSATION_EVENTS_PER_RUN = 200;

export function featureRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const projectId = c.req.query("projectId");
      if (!projectId) return c.json({ error: "projectId is required" }, 400);
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select()
        .from(features)
        .where(and(
          eq(features.projectId, projectId),
          // A card can be completed, reopened, and completed again, so
          // its status-change log is the completion clock. updated_at
          // also moves for unrelated edits and cannot answer this.
          sql`${features.status} <> 'done' or exists (
            select 1
            from ${featureEvents}
            where ${featureEvents.featureId} = ${features.id}
              and ${featureEvents.kind} = 'status_changed'
              and ${featureEvents.toStatus} = 'done'
              and ${featureEvents.at} >= now() - interval '14 days'
          )`,
        ));
      return c.json(await withPullRequestUrls(c, ctx, rows));
    })
    .post("/", zValidator("json", createFeature), async (c) => {
      const body = c.req.valid("json");
      if (!(await canAccessProject(ctx, c, body.projectId))) return c.json({ error: "not found" }, 404);
      const [pipeline] = await db(c, ctx)
        .select()
        .from(pipelines)
        .where(eq(pipelines.projectId, body.projectId));
      if (!pipeline) return c.json({ error: "project has no pipeline" }, 400);
      /**
       * The parent has to be one the caller can already see, in this
       * same project, and not at the bottom of a chain of splits. The
       * access check comes first and answers the same 404 a bad id
       * would, so naming another tenant's card teaches nothing.
       */
      if (body.parentId) {
        const parent = await getAccessibleFeature(ctx, c, body.parentId);
        if (!parent) return c.json({ error: "not found" }, 404);
        const refusal = await parentRefusal(db(c, ctx), {
          parentId: body.parentId,
          projectId: body.projectId,
        });
        if (refusal) return c.json({ error: refusal }, 400);
      }
      const [feature] = await db(c, ctx)
        .insert(features)
        .values({
          projectId: body.projectId,
          pipelineId: pipeline.id,
          title: body.title,
          description: body.description,
          ...(body.parentId ? { parentId: body.parentId } : {}),
        })
        .returning();
      if (!feature) return c.json({ error: "something went wrong saving the card; try again" }, 500);
      // Mirror the card into Linear when the workspace wants that.
      // Queued, so a slow or failing Linear API never keeps the card
      // from reaching the board, and queued after the commit, so the
      // worker cannot look for this card before it exists. The metric
      // waits for the commit for the same reason: an event counted for
      // a card whose transaction rolled back is a card that never was.
      const createdBy = actor(c);
      deferAfterCommit(c, async () => {
        ctx.analytics?.capture({
          event: "feature card created",
          userId: createdBy,
          organizationId: feature.organizationId,
          properties: { feature_id: feature.id, project_id: feature.projectId },
        });
        await queueLinearIssueCreate(ctx, feature);
      });
      return c.json(feature, 201);
    })
    .get("/:id", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      // Newest first: the run someone opens this card for is almost
      // always the latest one, so it must not hide below a scroll.
      const runs = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.featureId, feature.id))
        .orderBy(desc(agentRuns.queuedAt));
      const [withUrl] = await withPullRequestUrls(c, ctx, [feature]);
      /**
       * All of them, not just the first. A card spanning a frontend and
       * a backend has a pull request in each and is only finished when
       * both are, so the drawer has to be able to list them; the
       * feature's own prUrl is the first one, which is what the board's
       * single link uses.
       */
      const pullRequests = await featurePullRequestTargets(db(c, ctx), feature);
      /**
       * And everything it opened before those, because a card that
       * merges a branch and is asked for more opens another pull
       * request on a new branch: what it has shipped is the list, and
       * a card that showed only its live one looked like it had never
       * shipped anything. Rows only, so opening a card still costs no
       * GitHub round trip; whether each one merged comes from
       * /pull-request-status.
       */
      const history = await featurePullRequestHistory(db(c, ctx), feature);
      return c.json({
        ...(withUrl ?? feature),
        runs: await runsForCaller(ctx, c, runs),
        pullRequests: pullRequests.map((pr) => ({
          // A repository removed from the project leaves its pull
          // request behind, so the name falls back to the address it
          // was opened against rather than reading as unnamed.
          name: pr.name ?? repoNameFromUrl(pr.repoUrl),
          number: pr.number,
          url: pr.url,
        })),
        pullRequestHistory: history.map((pr) => ({
          name: pr.name ?? repoNameFromUrl(pr.repoUrl),
          number: pr.number,
          url: pr.url,
          branch: pr.branch,
          current: pr.current,
        })),
      });
    })
    /**
     * Removes the card and everything Bento holds about it: its runs
     * and their transcripts, its history, its gate checks, and the
     * sandbox it was worked in. Recorded spend goes with the runs, so
     * the project's total drops; the confirmation names the figure
     * before anybody clicks it.
     *
     * What survives is the user's: the branch in every source
     * repository, and any pull request opened from it. Bento stops
     * tracking those, it does not close them.
     *
     * A card that spawned others is refused instead. The foreign key
     * has no cascade on purpose: the parts of a split are ordinary
     * cards with their own branches and pull requests, and one click
     * on the card they came from must not take all of them. Delete or
     * finish the children first.
     */
    .delete("/:id", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);

      const outcome = await db(c, ctx)
        .transaction(async (tx) => {
          /**
           * The same row lock startRunIfIdle takes, which is the whole
           * concurrency story: a delete and a run start on one card
           * serialize here, and whoever loses sees what the winner
           * did. No row means another tab deleted it while this
           * request was resolving access.
           */
          const [locked] = await tx
            .select({ id: features.id })
            .from(features)
            .where(eq(features.id, feature.id))
            .for("update");
          if (!locked) return "gone" as const;

          // After the lock, so a part filed in the same instant is
          // counted rather than surfacing a foreign key violation as
          // a 500. The console disables the button from the same fact;
          // this is the door, not the hint.
          const children = await childCount(tx, feature.id);
          if (children > 0) return { refused: parentDeleteRefusal(children) };

          const [active] = await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(and(eq(agentRuns.featureId, feature.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
            .limit(1);
          // Queued counts as working, which also means no run.execute
          // job can name a run this delete is about to remove.
          if (active) return "busy" as const;

          /**
           * The machines go before the rows, and a failure here fails
           * the request. A destroyed machine with its card still on
           * the board is a retry; the other order leaves a metered
           * sandbox nothing in the product can still name.
           *
           * Read whole, destroyed ones included: their rows have to go
           * too, or the delete leaves exactly the pointerless row that
           * is supposed to mean "a machine is adrift".
           */
          const owned = await tx.select().from(sandboxes).where(eq(sandboxes.featureId, feature.id));
          for (const sandbox of owned.filter((s) => s.status !== "destroyed")) {
            try {
              const driver = driverForSandbox(ctx.drivers, sandbox, ctx);
              const handle: SandboxHandle = {
                externalId: sandbox.externalId,
                provider: driver.provider,
                workdir: sandbox.workdir,
                ...(sandbox.imageRef ? { imageRef: sandbox.imageRef } : {}),
              };
              await driver.destroy(handle);
            } catch (err) {
              if (err instanceof SandboxDriverUnavailable) {
                throw new SandboxDestroyFailed(
                  `No ${err.provider} driver is configured on this server, so the sandbox cannot be destroyed from here. The card was not deleted.`,
                  true,
                );
              }
              throw new SandboxDestroyFailed(err instanceof Error ? err.message : String(err));
            }
          }

          // Local mode works the card in a worktree beside each
          // repository. Removing one leaves the branch it had checked
          // out exactly where it is, which is the promise this feature
          // makes; anything uncommitted in it goes, same as the
          // sandbox being thrown away. The workspace directory itself
          // goes too: leftover node_modules are not a worktree and
          // would otherwise sit around after the card is gone.
          const repos = await tx.select().from(repositories).where(eq(repositories.projectId, feature.projectId));
          await ctx.worktrees.removeWorkspace(repos, feature.id);

          // Runs (and their transcripts), gate checks, history and
          // pull request links all cascade from this row.
          await tx.delete(features).where(eq(features.id, feature.id));
          /**
           * The sandbox rows go last, and by id.
           *
           * Last because agent_runs.sandbox_id is "no action": deleting
           * a sandbox while a run still points at it is a foreign key
           * violation, and every card with a sandbox has such a run.
           * By id because the delete above has already set their
           * feature_id to null, so "where feature_id = ..." would now
           * match nothing and leave them behind.
           *
           * Explicitly rather than by cascade, because that "set null"
           * is deliberate: a row deleted outside Bento should leave a
           * pointerless row as evidence of a machine still running.
           * Here the machines are confirmed gone first, so the count
           * this feature is measured by stays at zero.
           */
          if (owned.length > 0) {
            await tx.delete(sandboxes).where(
              inArray(
                sandboxes.id,
                owned.map((s) => s.id),
              ),
            );
          }
          return "deleted" as const;
        })
        .catch((err: unknown) => {
          if (err instanceof SandboxDestroyFailed) return err;
          throw err;
        });

      if (outcome instanceof SandboxDestroyFailed) {
        if (outcome.permanent) return c.json({ error: outcome.message }, 409);
        return c.json(
          { error: `the sandbox could not be destroyed (${outcome.message}). The card was not deleted; try again` },
          502,
        );
      }
      // Answering 404 rather than success to a repeat, for the reason
      // the profiles delete already writes down: success would say the
      // same thing to "deleted it already" and to "that is not yours".
      if (outcome === "gone") return c.json({ error: "not found" }, 404);
      if (outcome === "busy") return c.json({ error: CARD_BUSY_DELETE }, 409);
      if (typeof outcome === "object" && "refused" in outcome) {
        return c.json({ error: outcome.refused }, 409);
      }

      ctx.bus.emitBoardEvent({
        type: "feature_deleted",
        projectId: feature.projectId,
        featureId: feature.id,
      });
      return c.json({ ok: true });
    })
    /**
     * The card's whole conversation: every finished run's events, in
     * order, with the agent that spoke them. The live run is excluded
     * on purpose; clients stream it and append, so nothing is said
     * twice. This is what lets the log read as one continuing exchange
     * instead of resetting with every follow-up run.
     */
    .get("/:id/conversation", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const terminal = ["succeeded", "failed", "cancelled"];
      const runRows = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.featureId, feature.id))
        .orderBy(asc(agentRuns.queuedAt));
      // The last 30 finished runs bound the payload; a card with sixty
      // historical runs does not need them all to read as a conversation.
      const finishedRuns = runRows.filter((r) => terminal.includes(r.status)).slice(-30);
      // Looked up by the runs' own profiles rather than by who is
      // asking: in a shared organization a colleague's agent used to
      // render as "agent" because only the caller's profiles resolved.
      const profileIds = [...new Set(finishedRuns.map((r) => r.agentProfileId))];
      const profileRows = profileIds.length
        ? await db(c, ctx)
            .select({ id: agentProfiles.id, name: agentProfiles.name })
            .from(agentProfiles)
            .where(inArray(agentProfiles.id, profileIds))
        : [];
      const names = new Map(profileRows.map((p) => [p.id, p.name]));

      /**
       * The tail of each run, not the whole of it. A long run's
       * transcript is thousands of rows, most of them tool output, and
       * thirty of those at once is what made a card slow to open. The
       * block says how many earlier lines exist and where its first
       * one sits, and the runs route serves the rest a page at a time
       * when somebody asks for them (GET /api/runs/:id/events/before).
       */
      const blocks = [];
      for (const run of finishedRuns) {
        const tail = await db(c, ctx)
          .select({ seq: runEvents.seq, payload: runEvents.payload })
          .from(runEvents)
          .where(eq(runEvents.runId, run.id))
          .orderBy(desc(runEvents.seq))
          .limit(CONVERSATION_EVENTS_PER_RUN);
        tail.reverse();
        const firstSeq = tail[0]?.seq ?? null;
        const earlierRows = firstSeq === null || firstSeq <= 1
          ? []
          : await db(c, ctx)
              .select({ earlier: sql<number>`count(*)::int` })
              .from(runEvents)
              .where(and(eq(runEvents.runId, run.id), sql`${runEvents.seq} < ${firstSeq}`));
        const earlier = earlierRows[0]?.earlier ?? 0;
        blocks.push({
          runId: run.id,
          agentName: names.get(run.agentProfileId) ?? "agent",
          queuedAt: run.queuedAt,
          status: run.status,
          events: tail.map((e) => e.payload),
          firstSeq,
          earlier,
        });
      }
      // Messages waiting for an agent, so a reload does not make a
      // parked message look like it never existed.
      const pending = await db(c, ctx)
        .select()
        .from(featureMessages)
        .where(and(eq(featureMessages.featureId, feature.id), inArray(featureMessages.status, ["queued", "sent"])))
        .orderBy(asc(featureMessages.createdAt));
      return c.json({
        blocks,
        pending: pending.map((m) => ({ id: m.id, text: m.text, status: m.status, createdAt: m.createdAt })),
      });
    })
    /**
     * A message to the card's agent, whatever the agent is doing.
     *
     * Idle: the message resumes the latest session immediately, so the
     * agent answers with its context intact. Working: a headless CLI
     * run cannot hear mid-flight, so the message waits on the feature
     * and is delivered as a resume the moment the run ends. The caller
     * learns which happened.
     */
    .post("/:id/message", bodyLimit({ maxSize: 12 * 1024 * 1024 }), zValidator("json", z.object({ text: z.string().max(20000), attachments: messageAttachments.optional() })), async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      const body = c.req.valid("json");
      let text = body.text.trim();
      if (!text && !body.attachments?.length) return c.json({ error: "Enter a message or attach a file." }, 400);
      if (body.attachments?.length && !(await getBetaTester(ctx, c))) return c.json({ error: "not found" }, 404);
      const [newest] = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.featureId, feature.id), eq(agentRuns.type, "pipeline")))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
      if (!newest) {
        return c.json({ error: "no agent has run on this card yet; start one first" }, 400);
      }
      const latest = asPipelineRun(newest);
      const working =
        latest.status === "queued" || latest.status === "starting" || latest.status === "running";
      // A live run already has a workspace. An idle card would start a
      // new one, which cannot happen until the project has a checkout.
      if (!working && !(await projectHasRepositories(db(c, ctx), feature.projectId))) {
        return c.json({ error: NO_REPOSITORIES }, 409);
      }

      if (body.attachments?.length) {
        const [sandbox] = await db(c, ctx).select().from(sandboxes)
          .where(and(eq(sandboxes.featureId, feature.id), ne(sandboxes.status, "destroyed")))
          .orderBy(desc(sandboxes.createdAt)).limit(1);
        if (!sandbox) return c.json({ error: "This card has no available agent workspace. Start an agent before attaching files." }, 409);
        try {
          const driver = driverForSandbox(ctx.drivers, sandbox, ctx);
          const files = await writeMessageAttachments(driver, { externalId: sandbox.externalId, provider: driver.provider, workdir: sandbox.workdir }, body.attachments);
          text = `${text || "Please review the attached files."}\n\nAttached files in your workspace (use your file or image-reading tools to inspect them):\n${files.map(file => JSON.stringify(file)).join("\n")}`;
        } catch (error) {
          // A missing driver will not succeed on a retry. 503 is the
          // transfer failure, which might.
          if (error instanceof SandboxDriverUnavailable) {
            return c.json({ error: "This workspace cannot receive attachments from this server." }, 409);
          }
          return c.json({ error: error instanceof Error ? error.message : "Could not attach files." }, 503);
        }
      }

      /**
       * Durable before anything else: the row is the message's
       * identity, and whatever the delivery attempt below does (a live
       * write, a run creation, a crash between the two), the message
       * now exists somewhere the lifecycle and the boot sweep can find
       * it. The old single queued_prompt column was a slot, not a
       * queue, and messages could vanish after their sender was told
       * "queued".
       */
      const messageId = await enqueueMessage(db(c, ctx), feature.id, text, actor(c));

      if (latest.status === "queued" || latest.status === "starting" || latest.status === "running") {
        // A live session hears the message now; the tool decides
        // whether that steers the current work (pi) or queues behind
        // the current turn (Claude Code). No live session: the message
        // stays parked until the run ends.
        const liveSession = ctx.liveInputs.get(latest.id);
        if (liveSession && (await liveSession.deliver(text))) {
          await db(c, ctx)
            .update(featureMessages)
            .set({ status: "sent", runId: latest.id, sentAt: new Date() })
            .where(eq(featureMessages.id, messageId));
          return c.json({ queued: false as const, live: true as const, delivery: liveSession.delivery });
        }
        /*
         * The run may be live on another server, whose stdin this
         * process cannot see. The row is committed first, then that
         * server is told to claim it (run-ownership.ts), and the row
         * is watched for about a second for its answer: sent means the
         * holder wrote it into the agent, and the response says live.
         * A run with no live session anywhere leaves it parked until
         * the run ends, as before, and the response says queued.
         */
        respondAfterCommit(c, async () => {
          const sent = await nudgeAndAwaitSent(ctx, latest.id, async () => {
            const [row] = await ctx.db
              .select({ status: featureMessages.status })
              .from(featureMessages)
              .where(eq(featureMessages.id, messageId))
              .limit(1);
            return row?.status === "sent";
          });
          if (!sent) return null;
          const delivery = (await liveDeliveryOf(ctx, latest.id)) ?? "queue";
          return c.json({ queued: false as const, live: true as const, delivery });
        });
        return c.json({ queued: true as const });
      }
      /**
       * The conversation a follow-up continues is the card's own work,
       * never a judge's. Judge runs are ordinary rows on the feature,
       * so "the newest run" was sometimes the reviewer, and the user's
       * message came back answered by the judge inside the judging
       * session. The newest run that is not a judge run is the one
       * whose agent, stage, and session the message belongs to, unless
       * the card has moved: send-back puts it on a different stage,
       * and that stage's pipeline agent takes over rather than the
       * one that just ran.
       */
      const conversation = await latestConversationRun(db(c, ctx), feature.id);
      const resumeFrom = await resolveFollowUpRun(db(c, ctx), feature, conversation ?? latest);
      // Everything parked rides along, oldest first: the card is idle,
      // so this message and any it queued behind become one follow-up
      // run. Tools with a session resume it; pool gets fresh context.
      const claimed = await claimQueuedMessages(db(c, ctx), feature.id);
      if (claimed.length === 0) {
        // A terminal path claimed it in the same instant; its run
        // carries the message.
        return c.json({ queued: true as const });
      }
      const run = await startRunIfIdle(db(c, ctx), {
        type: "pipeline" as const,
        featureId: feature.id,
        stageId: resumeFrom.stageId,
        agentProfileId: resumeFrom.agentProfileId,
        prompt: claimed.map((m) => m.text).join("\n"),
        cliSessionId: resumeFrom.cliSessionId,
        executor: resumeFrom.executor,
        // The person sending the message owns the hours the resumed
        // run spends, not whoever started the conversation.
        startedBy: actor(c),
      }, ctx.entitlements, ctx.analytics, (task) => deferAfterCommit(c, async () => task()));
      // A run started in the gap between the read and the insert; the
      // messages wait for it like any other mid-run message.
      if (run === "busy") {
        await requeueMessages(db(c, ctx), claimed.map((m) => m.id));
        return c.json({ queued: true as const });
      }
      // Deleted in the gap: there is no card left to park a message on.
      if (run === "gone") return c.json({ error: "not found" }, 404);
      if ("outOfCompute" in run) {
        // Out of compute: held rather than thrown away. Queued is the
        // honest answer, and the stranded sweep delivers it once the
        // plan allows work again, which is what sending it meant.
        await requeueMessages(db(c, ctx), claimed.map((m) => m.id));
        return c.json({ queued: true as const });
      }
      // The run's prompt now carries them, so they are delivered rather
      // than in flight: a run that fails is resumed, not redelivered.
      await markMessagesDelivered(db(c, ctx), claimed.map((m) => m.id), run.id);
      if (resumeFrom.executor === "server") await enqueueRun(ctx, run.id);
      return c.json({ queued: false as const, run }, 201);
    })
    /**
     * Everything the card's agents have produced: per repository, the
     * changed files, the diff against the branch point, and the stage
     * write-ups committed under docs/bento/. Read from the feature
     * branch in each source repository, so it survives the sandbox and
     * the worktree both being gone.
     */
    .get("/:id/changes", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const repos = await collectFeatureChanges(ctx, feature.projectId, feature.branchName);
      return c.json({ branch: feature.branchName, repositories: repos });
    })
    /**
     * The card's artifacts, newest first: stage write-ups, mockups,
     * screenshots, captured per run so earlier stages' output survives
     * later rewrites. Metadata only; the console fetches one artifact's
     * body from /api/artifacts/:id/content when somebody opens it.
     */
    .get("/:id/artifacts", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select({
          id: runArtifacts.id,
          runId: runArtifacts.runId,
          stageSlug: runArtifacts.stageSlug,
          stageName: runArtifacts.stageName,
          path: runArtifacts.path,
          kind: runArtifacts.kind,
          mime: runArtifacts.mime,
          size: runArtifacts.size,
          createdAt: runArtifacts.createdAt,
        })
        .from(runArtifacts)
        .where(eq(runArtifacts.featureId, feature.id))
        .orderBy(desc(runArtifacts.createdAt))
        .limit(200);
      return c.json(rows);
    })
    /**
     * The group this card belongs to: the card a split started from,
     * and every card that split produced.
     *
     * One endpoint for both ends of the relationship. Opened from a
     * child it resolves upward first, so the parent and the child
     * answer with the same group and the view reads the same from
     * either. The rows come from the database rather than from the
     * caller's board, which is what keeps a finished part, or one that
     * has been moved to another lane, in the picture.
     *
     * Null for a card that is neither a parent nor a child, which is
     * most cards: the console draws nothing rather than an empty view.
     */
    .get("/:id/related", async (c) => {
      // Unfinished product, so a non-tester must not learn the route
      // exists. The access check still runs after it: the flag is not
      // an authorization boundary.
      if (!(await getBetaTester(ctx, c))) return c.json({ error: "not found" }, 404);
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      return c.json(await relatedGroup(db(c, ctx), feature));
    })
    /**
     * Moves the card forward unconditionally: the user is the gate.
     * From backlog it enters the first stage. Use /approve instead when
     * the stage has automated criteria that should also be satisfied.
     */
    .post("/:id/advance", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      if (!feature.currentStageId) {
        const refused = await activationRefusal(ctx, feature);
        if (refused) return c.json({ error: refused }, 402);
      }
      // The stage guard makes a double click one advance, not two.
      const result = await advanceFeature(ctx, feature.id, "manual", actor(c), feature.currentStageId);
      if (!result) return c.json({ error: "this project has no stages yet; add them under Pipeline first" }, 400);
      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /**
     * Sends the card back one stage, for work that needs redoing. From
     * the first stage it returns to the backlog.
     */
    .post("/:id/back", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "cancelled") return c.json({ error: "feature is cancelled" }, 409);

      /**
       * From done, back means reopen: the card returns to the stage it
       * finished in, not the one before it, because "done" is one step
       * past the last stage rather than a stage of its own.
       *
       * Without this a finished card was frozen: every move refused,
       * so one mis-click on the final approve was permanent. Reopening
       * starts nothing by itself; the reopened stage waits for a person
       * the way any freshly entered stage does.
       *
       * Asked before the backlog refusal below, because a card marked
       * done straight from the backlog has no stage either and is
       * exactly the card that must not be frozen.
       */
      if (feature.status === "done") {
        const refused = await activationRefusal(ctx, feature);
        if (refused) return c.json({ error: refused }, 402);
        const result = await reopenFeature(ctx, feature.id, actor(c));
        if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);
        const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
        return c.json(updated);
      }

      if (!feature.currentStageId) return c.json({ error: "feature is already in the backlog" }, 409);

      const result = await moveFeatureBack(ctx, feature.id, "manual", actor(c));
      if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);
      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /**
     * Marks the card done from wherever it is, skipping the stages it
     * has not been through. This is what dropping a card on the board's
     * Done lane calls.
     *
     * Its own route rather than a target of /move, because done is a
     * status and not a stage: /move puts a card in a lane the pipeline
     * defines, and there is no stage id to name here.
     */
    .post("/:id/finish", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done") return c.json({ error: "feature is already done" }, 409);
      if (feature.status === "cancelled") return c.json({ error: "feature is cancelled; reopen it first" }, 409);
      // No activation check: a card going to done stops being live, and
      // the plan counts live cards.
      const result = await finishFeature(ctx, feature.id, actor(c));
      if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);
      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /**
     * Puts the card in any stage of its pipeline, or the backlog. This
     * is what dragging a card between lanes calls: forward behaves like
     * advance, backward like send-back (the previous agent stops, the
     * destination waits for a conversation), and neither records an
     * approval, because rearranging the board is not a verdict.
     */
    .post(
      "/:id/move",
      zValidator("json", z.object({ stageId: z.string().uuid().nullable() })),
      async (c) => {
        const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
        if (!feature) return c.json({ error: "not found" }, 404);
        if (feature.status === "done" || feature.status === "cancelled") {
          return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
        }
        const target = c.req.valid("json").stageId;
        if (!feature.currentStageId && target) {
          const refused = await activationRefusal(ctx, feature);
          if (refused) return c.json({ error: refused }, 402);
        }
        const result = await moveFeatureTo(ctx, feature.id, target, actor(c));
        if (!result) return c.json({ error: "that stage is not part of this card's pipeline" }, 400);
        const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
        return c.json(updated);
      },
    )
    /**
     * Approves a manual stage, which advances the card.
     *
     * A manual stage is a person's decision and consults no criteria,
     * so this moves the card rather than feeding a later evaluation.
     * Automatic stages advance on their own and never reach here.
     */
    .post("/:id/approve", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (!feature.currentStageId) return c.json({ error: "feature is not in a stage" }, 400);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }

      // A manual stage is a person's decision, so approving IS the
      // advance rather than an input to a later evaluation. The
      // approval is still recorded, because the history should say who
      // decided and when.
      await recordManualApproval(ctx, feature.id, feature.currentStageId);
      const result = await advanceFeature(ctx, feature.id, "manual", actor(c), feature.currentStageId);
      if (!result) return c.json({ error: "this project has no stages yet; add them under Pipeline first" }, 400);

      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      const checks = await db(c, ctx).select().from(gateChecks).where(eq(gateChecks.featureId, feature.id));
      return c.json({ feature: updated, gateChecks: checks });
    })
    /**
     * The other half of a manual gate: this is not right yet, so the
     * card goes back to where the fixing happens, and to the backlog
     * from the first stage.
     */
    .post("/:id/reject", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (!feature.currentStageId) return c.json({ error: "feature is not in a stage" }, 400);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      const reason = c.req.query("reason")?.slice(0, 500);

      await recordRejection(ctx, feature.id, feature.currentStageId, reason);
      const result = await moveFeatureBack(ctx, feature.id, "manual", actor(c));
      if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);

      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /** Current gate status for the card, one row per criterion. */
    .get("/:id/gate", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const checks = feature.currentStageId
        ? await db(c, ctx)
            .select()
            .from(gateChecks)
            .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, feature.currentStageId)))
        : [];
      return c.json({ status: feature.status, currentStageId: feature.currentStageId, checks });
    })
    /** Forces a gate re-check (the "re-run checks" button). */
    .post("/:id/recheck", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      // Refused out loud: the evaluator would quietly skip these, and a
      // button that 200s while doing nothing teaches distrust.
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      if (!feature.currentStageId) {
        return c.json({ error: "feature is not in a stage; there is no gate to check" }, 400);
      }
      await evaluateFeatureGate(ctx, feature.id);
      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /**
     * Pushes the card's branch and opens its pull requests, on demand.
     *
     * The same publishing the per stage "Create a pull request" setting
     * does automatically, behind a button: whatever stage the card is
     * in, whatever the stage settings say, publish what is committed
     * right now. The server pushes, never the agent, for the same
     * reason as always: a push credential must not enter a sandbox.
     *
     * Where the commits are read from depends on the driver. A local
     * card's work is in the host's worktrees; a hosted card's work is
     * inside its sandbox, which the server cannot mount, so the driver
     * exports it as bundles, the same handoff a finished run uses.
     * Either way the organization's GitHub App installation answers the
     * push when there is one, before any saved token is consulted.
     */
    .post("/:id/publish", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (!feature.branchName) {
        return c.json({ error: "this card has no branch yet; run an agent on it first" }, 409);
      }
      const publisher = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      if (!publisher) {
        return c.json({ error: GITHUB_NOT_CONNECTED }, 409);
      }
      const selected = await db(c, ctx)
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, feature.projectId))
        .orderBy(asc(repositories.position));
      if (selected.length === 0) {
        return c.json({ error: "the project has no repositories, so there is nothing to publish" }, 409);
      }
      // Repositories added by path before their remote was read still
      // have no URL. Reading it here means an older project publishes
      // rather than refusing for a link its checkout has always had.
      const repoRows =
        ctx.env.BENTO_MODE === "multi" ? selected : await linkGitHubRemotes(db(c, ctx), selected);
      const includeStageNotes = await shouldIncludeStageNotes(ctx, feature.organizationId);

      // The row picks the driver. A clone driver exports bundles from
      // the sandbox; a host driver reads the worktrees it mounted.
      const [sandbox] = await db(c, ctx)
        .select()
        .from(sandboxes)
        .where(and(eq(sandboxes.featureId, feature.id), ne(sandboxes.status, "destroyed")))
        .orderBy(desc(sandboxes.createdAt))
        .limit(1);
      let publishDriver: SandboxDriver;
      try {
        publishDriver = sandbox ? driverForSandbox(ctx.drivers, sandbox, ctx) : ctx.drivers.default;
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "no driver configured on this server" }, 409);
      }
      const exportRepository = publishDriver.exportRepository?.bind(publishDriver);
      let publishable: PublishableRepository[];
      if (exportRepository) {
        // The card's sandbox holds the checkouts. It outlives the run
        // that made it, so the latest row that was not destroyed is the
        // one to read; a card with none has never run anywhere.
        if (!sandbox) {
          return c.json({ error: "this card has no sandbox yet; run an agent on it first, then publish" }, 409);
        }
        const handle: SandboxHandle = {
          externalId: sandbox.externalId,
          provider: publishDriver.provider,
          workdir: sandbox.workdir,
        };
        publishable = repoRows.map((row) => {
          const githubRepoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
          return {
            id: row.id,
            name: row.name,
            repoUrl: row.repoUrl,
            githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
            defaultBranch: row.defaultBranch,
            exportBundle: () => exportRepository(handle, row.name, row.defaultBranch),
          };
        });
      } else {
        // Ensured rather than assumed: worktrees are cleaned up over
        // time, and a fresh one at the branch still answers correctly
        // (no commits beyond the base means nothing to publish).
        const prepared = await ctx.worktrees.ensureAll(
          repoRows.map((r) => ({ name: r.name, localPath: r.localPath, defaultBranch: r.defaultBranch })),
          feature.id,
          feature.branchName,
        );
        publishable = repoRows.map((row) => {
          const preparedRepo = prepared.find((p) => p.name === row.name);
          const githubRepoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
          return {
            id: row.id,
            name: row.name,
            repoUrl: row.repoUrl,
            githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
            defaultBranch: row.defaultBranch,
            ...(preparedRepo ? { worktreePath: preparedRepo.worktreePath } : {}),
          };
        });
      }
      const { published, failures } = await publishFeatureBranches(ctx.db, publisher, {
        featureId: feature.id,
        featureTitle: feature.title,
        branch: feature.branchName,
        repositories: publishable,
      }, { includeStageNotes });
      const rebaseTargets: RebaseTarget[] = failures.map((f) => ({
        name: f.name,
        defaultBranch: publishable.find((r) => r.name === f.name)?.defaultBranch ?? "main",
      }));
      const recovery = await recoverAncestryPublishFailures(
        ctx,
        db(c, ctx),
        feature,
        failures,
        rebaseTargets,
        {
          publisher,
          branch: feature.branchName,
          repositories: publishable,
          includeStageNotes,
        },
        actor(c),
        (task) => deferAfterCommit(c, async () => task()),
      );
      const ancestryNames = new Set(
        failures.filter((f) => recovery.draftPublished.some((p) => p.name === f.name)).map((f) => f.name),
      );
      const allPublished = [...published, ...recovery.draftPublished];
      // The same as a run's publish: whatever an agent asked the pull
      // request to say, and no publish has applied yet, lands now.
      if (allPublished.length > 0) {
        await applyPendingPullRequestUpdates(ctx.db, publisher, {
          featureId: feature.id,
          branch: feature.branchName,
          targets: allPublished,
        });
      }
      const remainingFailures = [
        ...failures.filter((f) => !ancestryNames.has(f.name)),
        ...recovery.draftFailures,
      ];
      const rebaseRun = recovery.rebaseRun;
      if (allPublished.length > 0) {
        ctx.bus.emitBoardEvent({
          type: "feature_updated",
          projectId: feature.projectId,
          featureId: feature.id,
          status: feature.status,
          currentStageId: feature.currentStageId,
        });
      }
      if (rebaseRun) {
        ctx.bus.emitBoardEvent({
          type: "run_updated",
          projectId: feature.projectId,
          featureId: feature.id,
          runId: rebaseRun.id,
          status: "queued",
        });
      }
      return c.json({ published: allPublished, failures: remainingFailures, rebaseRun: rebaseRun ?? null });
    })
    /**
     * Where each of the card's pull requests stands against its base:
     * clean, conflicted, or unknown. Its own request rather than part of
     * the card detail, because answering it costs a GitHub round trip
     * per pull request and most card opens do not need it to render.
     */
    .get("/:id/merge-status", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const rows = c.req.query("history") === "all"
        ? await featurePullRequestHistory(db(c, ctx), feature)
        : await featurePullRequestTargets(db(c, ctx), feature);
      if (rows.length === 0) return c.json([]);
      const connection = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      const states = await readMergeStates(connection, rows);
      // The base branch is the resolve route's business, not the
      // drawer's; dropped by rest-destructuring so a field added to the
      // row later travels without anyone remembering this projection.
      return c.json(states.map(({ defaultBranch, ...pr }) => pr));
    })
    /**
     * How each pull request the card has ever opened ended: merged,
     * open, closed without merging, or unknown. Its own request for
     * the same reason as merge-status, and asked of every row rather
     * than the live ones, because the history is the part of the card
     * that needs saying which is which.
     */
    .get("/:id/pull-request-status", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const rows = await featurePullRequestHistory(db(c, ctx), feature);
      if (rows.length === 0) return c.json([]);
      const connection = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      return c.json(await readPullRequestStates(connection, rows));
    })
    /**
     * How CI checks on each pull request head are doing: passed,
     * pending, failed, or unknown. Separate from merge-status because
     * most card opens do not need a GitHub round trip to render.
     */
    .get("/:id/check-status", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      const rows = c.req.query("history") === "all"
        ? await featurePullRequestHistory(db(c, ctx), feature)
        : await featurePullRequestTargets(db(c, ctx), feature);
      if (rows.length === 0) return c.json([]);
      const connection = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      const states = await readCheckStates(connection, rows);
      return c.json(states);
    })
    /**
     * Starts a run that fixes failing CI checks GitHub is reporting.
     *
     * Checks are re-read here rather than trusted from the button, so a
     * stale drawer cannot start a fix run nothing needs.
     */
    .post("/:id/fix-ci-tests", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      if (!feature.branchName) {
        return c.json({ error: "this card has no branch yet; run an agent on it first" }, 409);
      }
      const rows = await featurePullRequestTargets(db(c, ctx), feature);
      if (rows.length === 0) {
        return c.json({ error: "this card has no pull request yet; publish it first" }, 409);
      }
      const connection = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      if (!connection) {
        return c.json({ error: GITHUB_NOT_CONNECTED }, 409);
      }
      const states = await readCheckStates(connection, rows);
      const failing = states.filter((pr) => pr.state === "failed");
      if (failing.length === 0) {
        return c.json(
          {
            error: states.some((pr) => pr.state === "unknown")
              ? "GitHub check status could not be read for this card's pull requests. Try again in a moment."
              : states.some((pr) => pr.state === "pending")
                ? "CI checks are still running on this card's pull requests."
                : "GitHub reports no failing CI checks on this card's pull requests",
          },
          409,
        );
      }

      const result = await startFeatureFollowUpRun(
        ctx,
        db(c, ctx),
        feature,
        buildCiFixPrompt(failing),
        actor(c),
        "stage",
        (task) => deferAfterCommit(c, async () => task()),
      );
      if (!result.ok) {
        return c.json(
          { error: result.error, ...(result.code ? { code: result.code } : {}) },
          result.status,
        );
      }
      return c.json(result.run, 201);
    })
    /**
     * Starts a run that rebases the card's branch onto the latest base
     * branch and resolves the merge conflicts GitHub is reporting.
     *
     * The stage's agent does the resolving, in the card's own
     * conversation: it is the agent that made the changes, so it is the
     * one that knows their intent when both sides touched a line. The
     * agent only rebases and commits; the push is the server's, through
     * the same force-with-lease publishing every stage uses, which is
     * why the run carries the "rebase" kind: run-executor republishes
     * on it even when the stage itself is not set to create pull
     * requests.
     *
     * Conflicts are re-read from GitHub here rather than trusted from
     * the button, so a stale drawer cannot start a rebase nothing needs.
     */
    .post("/:id/resolve-conflicts", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      if (!feature.branchName) {
        return c.json({ error: "this card has no branch yet; run an agent on it first" }, 409);
      }
      const rows = await featurePullRequestTargets(db(c, ctx), feature);
      if (rows.length === 0) {
        return c.json({ error: "this card has no pull request yet; publish it first" }, 409);
      }
      const connection = await githubConnectionFor(ctx, feature.organizationId, db(c, ctx));
      if (!connection) {
        return c.json({ error: GITHUB_NOT_CONNECTED }, 409);
      }
      const states = await readMergeStates(connection, rows);
      const conflicted = states.filter((pr) => pr.state === "conflicted");
      if (conflicted.length === 0) {
        // "unknown" is not "clean": GitHub may still be computing, or
        // the read may have failed, and claiming it reported no
        // conflicts would put words in its mouth.
        return c.json(
          {
            error: states.some((pr) => pr.state === "unknown")
              ? "GitHub has not finished computing mergeability for this card's pull requests, or the state could not be read. Try again in a moment."
              : "GitHub reports no merge conflicts on this card's pull requests",
          },
          409,
        );
      }

      const result = await startFeatureRebaseRun(
        ctx,
        db(c, ctx),
        feature,
        buildConflictResolutionPrompt(feature.branchName, conflicted),
        actor(c),
        (task) => deferAfterCommit(c, async () => task()),
      );
      if (!result.ok) {
        return c.json(
          { error: result.error, ...(result.code ? { code: result.code } : {}) },
          result.status,
        );
      }
      return c.json(result.run, 201);
    })
    /** Links a pull request so PR based gate criteria can evaluate. */
    .post("/:id/link-pr", zValidator("json", z.object({ prNumber: z.number().int().positive() })), async (c) => {
      if (!(await getAccessibleFeature(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const [updated] = await db(c, ctx)
        .update(features)
        .set({ prNumber: c.req.valid("json").prNumber, updatedAt: new Date() })
        .where(eq(features.id, c.req.param("id")))
        .returning();
      if (!updated) return c.json({ error: "not found" }, 404);
      await ctx.boss.send("gate.evaluate", { featureId: updated.id });
      return c.json(updated);
    })
    /** Full history: stage moves and status changes, oldest first. */
    .get("/:id/history", async (c) => {
      if (!(await getAccessibleFeature(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const rows = await featureHistory(c, ctx, c.req.param("id"));
      return c.json(
        rows.map(({ event, actorName, actorEmail }) => ({
          ...event,
          actorName: actorName ?? null,
          actorEmail: actorEmail ?? null,
        })),
      );
    })
    /** Stage moves only. Kept for clients written before the history view. */
    .get("/:id/transitions", async (c) => {
      if (!(await getAccessibleFeature(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select()
        .from(featureEvents)
        .where(and(eq(featureEvents.featureId, c.req.param("id"))))
        .orderBy(asc(featureEvents.at));
      return c.json(rows);
    });
}
