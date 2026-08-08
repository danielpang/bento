import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, ne, notLike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_MODELS } from "@bento/agents";
import { agentCli, checkAgentPairing, gateCriterion } from "@bento/core";
import {
  agentProfiles,
  agentRuns,
  featureEvents,
  featureMessages,
  featurePullRequests,
  runEvents,
  features,
  gateChecks,
  pipelines,
  projects,
  repositories,
  sandboxes,
  stages,
} from "@bento/db";
import type { SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { canAccessProject, getAccessibleFeature } from "../access.js";
import {
  advanceFeature,
  evaluateFeatureGate,
  JUDGE_PROMPT_PREFIX,
  moveFeatureBack,
  moveFeatureTo,
  recordManualApproval,
  recordRejection,
  reopenFeature,
} from "../orchestrator/gate-evaluator.js";
import { CARD_BUSY, startRunIfIdle } from "../orchestrator/start-run.js";
import {
  claimQueuedMessages,
  enqueueMessage,
  markMessagesSent,
  requeueMessages,
} from "../orchestrator/messages.js";
import { publishFeatureBranches, type PublishableRepository } from "../orchestrator/publish.js";
import { linkGitHubRemotes } from "../orchestrator/repo-remote.js";
import { githubConnectionFor } from "../github.js";
import { shouldIncludeStageNotes } from "../settings.js";
import { collectFeatureChanges } from "../feature-changes.js";

const createFeature = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().default(""),
});

/**
 * One line of why a criterion is where it is. The evaluator writes a
 * `message` alongside criterion specific data; newlines would break the
 * line protocol, so they collapse to spaces.
 */
function summariseDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "-";
  const message = (detail as { message?: unknown }).message;
  if (typeof message !== "string" || message.length === 0) return "-";
  const flat = message.replaceAll(/[\r\n|]+/g, " ");
  // Cut at a word and say so, rather than stopping mid-syllable.
  return flat.length > 200 ? `${flat.slice(0, 199).replace(/\s+\S*$/, "")}…` : flat;
}

/** Human names for criterion types; raw tokens read as debug output. */
const CRITERION_LABELS: Record<string, string> = {
  manual: "Approval",
  run_succeeded: "Agent run",
  agent_judge: "Judge agent",
  command: "Command",
  checks_pass: "GitHub checks",
  pr_comments_resolved: "Review comments",
};

/** Who or what moved the card, in words rather than trigger tokens. */
const TRIGGER_WORDS: Record<string, string> = {
  manual: "by you",
  manual_back: "sent back by you",
  gate_auto: "by the gate",
  gate_auto_back: "returned by the gate",
  agent_run: "by an agent",
  system: "automatically",
};

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
  const byFeature = new Map<string, string>();
  for (const pr of prs) if (!byFeature.has(pr.featureId)) byFeature.set(pr.featureId, pr.url);
  return rows.map((row) => ({ ...row, prUrl: byFeature.get(row.id) ?? null }));
}

/** "acme/api" from a GitHub address, for a repository no longer in the project. */
function repoNameFromUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, "").split("/").slice(-2).join("/") || repoUrl;
}

/**
 * Asks the deployment's plan limits whether this card may go live. The
 * open source server has no limits and answers yes by standing aside;
 * a hosted deployment counts live cards against the organization's
 * plan. Only transitions INTO being live are asked: a live card moving
 * between stages changes nothing the plan counts.
 */
async function activationRefusal(
  ctx: AppContext,
  feature: { organizationId: string | null },
): Promise<string | null> {
  if (!ctx.entitlements || !feature.organizationId) return null;
  const refusal = await ctx.entitlements.canActivateFeature(feature.organizationId);
  return refusal ? refusal.reason : null;
}

export function featureRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const projectId = c.req.query("projectId");
      if (!projectId) return c.json({ error: "projectId is required" }, 400);
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx).select().from(features).where(eq(features.projectId, projectId));
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
      const [feature] = await db(c, ctx)
        .insert(features)
        .values({
          projectId: body.projectId,
          pipelineId: pipeline.id,
          title: body.title,
          description: body.description,
        })
        .returning();
      if (!feature) return c.json({ error: "something went wrong saving the card; try again" }, 500);
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
      const pullRequests = await db(c, ctx)
        .select({
          repoUrl: featurePullRequests.repoUrl,
          number: featurePullRequests.number,
          url: featurePullRequests.url,
          name: repositories.name,
        })
        .from(featurePullRequests)
        .leftJoin(repositories, eq(repositories.id, featurePullRequests.repositoryId))
        .where(eq(featurePullRequests.featureId, feature.id))
        .orderBy(asc(featurePullRequests.createdAt));
      return c.json({
        ...(withUrl ?? feature),
        runs,
        pullRequests: pullRequests.map((pr) => ({
          // A repository removed from the project leaves its pull
          // request behind, so the name falls back to the address it
          // was opened against rather than reading as unnamed.
          name: pr.name ?? repoNameFromUrl(pr.repoUrl),
          number: pr.number,
          url: pr.url,
        })),
      });
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

      const blocks = [];
      for (const run of finishedRuns) {
        const events = await db(c, ctx)
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .where(eq(runEvents.runId, run.id))
          .orderBy(asc(runEvents.seq));
        blocks.push({
          runId: run.id,
          agentName: names.get(run.agentProfileId) ?? "agent",
          queuedAt: run.queuedAt,
          status: run.status,
          events: events.map((e) => e.payload),
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
    .post("/:id/message", zValidator("json", z.object({ text: z.string().min(1).max(20000) })), async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      const text = c.req.valid("json").text.trim();
      const [latest] = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.featureId, feature.id))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
      if (!latest) {
        return c.json({ error: "no agent has run on this card yet; start one first" }, 400);
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
      const messageId = await enqueueMessage(db(c, ctx), feature.id, text);

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
        return c.json({ queued: true as const });
      }
      /**
       * The conversation a follow-up continues is the card's own work,
       * never a judge's. Judge runs are ordinary rows on the feature,
       * so "the newest run" was sometimes the reviewer, and the user's
       * message came back answered by the judge inside the judging
       * session. The newest run whose prompt is not a judge prompt is
       * the one whose agent, stage, and session the message belongs to.
       */
      const [conversation] = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.featureId, feature.id), notLike(agentRuns.prompt, `${JUDGE_PROMPT_PREFIX}%`)))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
      const resumeFrom = conversation ?? latest;
      // Everything parked rides along, oldest first: the card is idle,
      // so this message and any it queued behind become one resume run.
      const claimed = await claimQueuedMessages(db(c, ctx), feature.id);
      if (claimed.length === 0) {
        // A terminal path claimed it in the same instant; its run
        // carries the message.
        return c.json({ queued: true as const });
      }
      const run = await startRunIfIdle(db(c, ctx), {
        featureId: feature.id,
        stageId: resumeFrom.stageId,
        agentProfileId: resumeFrom.agentProfileId,
        prompt: claimed.map((m) => m.text).join("\n"),
        cliSessionId: resumeFrom.cliSessionId,
        executor: resumeFrom.executor,
      });
      // A run started in the gap between the read and the insert; the
      // messages wait for it like any other mid-run message.
      if (run === "busy") {
        await requeueMessages(db(c, ctx), claimed.map((m) => m.id));
        return c.json({ queued: true as const });
      }
      await markMessagesSent(db(c, ctx), claimed.map((m) => m.id), run.id);
      if (resumeFrom.executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
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
     * The same, pre-rendered as display lines: the Mac app has no JSON
     * parser, so every line here is already what its pane shows.
     */
    .get("/:id/changes/plain", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.text("error|not found", 404);
      const repos = await collectFeatureChanges(ctx, feature.projectId, feature.branchName);
      const lines: string[] = [];
      for (const repo of repos) {
        const adds = repo.files.reduce((n, f) => n + f.additions, 0);
        const dels = repo.files.reduce((n, f) => n + f.deletions, 0);
        lines.push(`== ${repo.name}  +${adds} -${dels} in ${repo.files.length} file${repo.files.length === 1 ? "" : "s"}`);
        for (const f of repo.files) lines.push(`   +${f.additions} -${f.deletions}  ${f.path}`);
        for (const artifact of repo.artifacts) {
          lines.push("", `-- ${artifact.path}`);
          lines.push(...artifact.content.replaceAll("\r", "").split("\n"));
        }
        if (repo.diff.trim()) {
          lines.push("", `-- diff (${repo.name})`);
          lines.push(...repo.diff.replaceAll("\r", "").split("\n"));
          if (repo.truncated) lines.push("... diff truncated; the full change is on the branch");
        }
        lines.push("");
      }
      if (lines.length === 0) {
        lines.push("Nothing committed yet. Changes and stage write-ups appear once an agent commits.");
      }
      const CAP = 1200;
      const body = lines.length > CAP ? [...lines.slice(0, CAP), "... truncated; see the web console for the rest"] : lines;
      return c.text(body.join("\n"));
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
      if (!feature.currentStageId) return c.json({ error: "feature is already in the backlog" }, 409);
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
       */
      if (feature.status === "done") {
        const refused = await activationRefusal(ctx, feature);
        if (refused) return c.json({ error: refused }, 402);
        const result = await reopenFeature(ctx, feature.id, actor(c));
        if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);
        const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
        return c.json(updated);
      }

      const result = await moveFeatureBack(ctx, feature.id, "manual", actor(c));
      if (!result) return c.json({ error: "the card moved while you were looking at it" }, 409);
      const [updated] = await db(c, ctx).select().from(features).where(eq(features.id, feature.id));
      return c.json(updated);
    })
    /**
     * Puts the card in any stage of its pipeline, or the backlog. This
     * is what dragging a card between lanes calls: forward behaves like
     * advance, backward like send-back, and neither records an
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
    /**
     * The same gate status in line form, for the Mac app.
     *
     *   gate|<featureStatus>|<currentStageId or ->
     *   check|<criterionType>|<status>|<detail>
     *
     * The detail is a one-line summary rather than the raw jsonb: a
     * client that cannot parse JSON has no use for the structure, and
     * what a person needs is why a criterion is red.
     */
    .get("/:id/gate/plain", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.text("error|not found", 404);
      const checks = feature.currentStageId
        ? await db(c, ctx)
            .select()
            .from(gateChecks)
            .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, feature.currentStageId)))
        : [];
      const lines = [`gate|${feature.status}|${feature.currentStageId ?? "-"}`];
      for (const check of checks) {
        const criterion = gateCriterion.safeParse(check.criterion);
        const type = criterion.success ? criterion.data.type : "unrecognized";
        lines.push(`check|${CRITERION_LABELS[type] ?? type}|${check.status}|${summariseDetail(check.detail)}`);
      }
      return c.text(lines.join("\n"));
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
      const publisher = await githubConnectionFor(ctx, feature.organizationId);
      if (!publisher) {
        return c.json(
          {
            error:
              "no GitHub connection is configured. Save a GitHub token under Settings, GitHub, or install the GitHub App, then try again.",
          },
          409,
        );
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

      const exportRepository = ctx.driver.exportRepository?.bind(ctx.driver);
      let publishable: PublishableRepository[];
      if (exportRepository) {
        // The card's sandbox holds the checkouts. It outlives the run
        // that made it, so the latest row that was not destroyed is the
        // one to read; a card with none has never run anywhere.
        const [sandbox] = await db(c, ctx)
          .select()
          .from(sandboxes)
          .where(and(eq(sandboxes.featureId, feature.id), ne(sandboxes.status, "destroyed")))
          .orderBy(desc(sandboxes.createdAt))
          .limit(1);
        if (!sandbox) {
          return c.json({ error: "this card has no sandbox yet; run an agent on it first, then publish" }, 409);
        }
        const handle: SandboxHandle = {
          externalId: sandbox.externalId,
          provider: sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider,
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
          repoRows.map((r) => ({ name: r.name, localPath: r.localPath })),
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
      if (published.length > 0) {
        ctx.bus.emitBoardEvent({
          type: "feature_updated",
          projectId: feature.projectId,
          featureId: feature.id,
          status: feature.status,
          currentStageId: feature.currentStageId,
        });
      }
      return c.json({ published, failures });
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
    /**
     * Starts a run on the feature's current stage using a shared
     * "quick" profile for the given cli, creating it on first use.
     * Exists so line-protocol clients (the Mac app) can start runs
     * without composing JSON.
     */
    .post("/:id/quick-run", async (c) => {
      const parsedCli = agentCli.safeParse(c.req.query("cli") ?? "claude-code");
      if (!parsedCli.success) return c.json({ error: `unknown agent "${c.req.query("cli")}"; supported: ${agentCli.options.join(", ")}` }, 400);
      const cli = parsedCli.data;
      const model = c.req.query("model") ?? DEFAULT_MODELS[cli];
      // This route creates a profile of its own, so it needs the same
      // pairing check the profile route applies. ?model= is the way an
      // impossible combination would otherwise get in through the back.
      const pairing = checkAgentPairing(cli, model);
      if (pairing.status === "impossible") return c.json({ error: pairing.detail, cli, model }, 400);

      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.json({ error: "not found" }, 404);
      if (!feature.currentStageId) return c.json({ error: "feature has no current stage; advance it first" }, 400);
      // A done card keeps the stage it finished in, so the stage check
      // alone would let an agent run on a card nobody is watching.
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }

      /**
       * The stage's assigned agent comes first: asking to "run
       * claude-code" on a stage whose agent IS a claude-code agent
       * means that agent, with its name and its skill. The nameless
       * quick-<cli> stand-in exists only for a stage with no matching
       * assignment, and ?model= opts out of the assigned agent because
       * it asks for a specific pairing.
       */
      const [stageRow] = feature.currentStageId
        ? await db(c, ctx).select().from(stages).where(eq(stages.id, feature.currentStageId)).limit(1)
        : [];
      let profile;
      if (stageRow?.defaultAgentProfileId && !c.req.query("model")) {
        const [assigned] = await db(c, ctx)
          .select()
          .from(agentProfiles)
          .where(eq(agentProfiles.id, stageRow.defaultAgentProfileId))
          .limit(1);
        if (assigned?.cli === cli) profile = assigned;
      }
      if (!profile) {
        const profileName = `quick-${cli}`;
        [profile] = await db(c, ctx)
          .select()
          .from(agentProfiles)
          .where(and(eq(agentProfiles.ownerId, actor(c)), eq(agentProfiles.name, profileName)));
        if (!profile) {
          [profile] = await db(c, ctx)
            .insert(agentProfiles)
            .values({ ownerId: actor(c), name: profileName, cli, model })
            .returning();
        }
      }
      if (!profile) return c.json({ error: "something went wrong saving the agent; try again" }, 500);

      const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, feature.projectId));
      const executor = project?.executor ?? "server";

      const run = await startRunIfIdle(db(c, ctx), {
        featureId: feature.id,
        stageId: feature.currentStageId,
        agentProfileId: profile.id,
        prompt: "",
        executor,
      });
      if (run === "busy") return c.json({ error: CARD_BUSY }, 409);
      if (executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
      return c.json(run, 201);
    })
    /** Full history: stage moves and status changes, oldest first. */
    .get("/:id/history", async (c) => {
      if (!(await getAccessibleFeature(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select()
        .from(featureEvents)
        .where(eq(featureEvents.featureId, c.req.param("id")))
        .orderBy(asc(featureEvents.at));
      return c.json(rows);
    })
    /**
     * Line format: event|<at>|<kind>|<trigger>|<description>
     * Stage names are resolved here because the Native SDK client has no
     * JSON parser and no way to join.
     */
    .get("/:id/history/plain", async (c) => {
      const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
      if (!feature) return c.text("error|not found", 404);
      const [rows, stageRows] = await Promise.all([
        db(c, ctx)
          .select()
          .from(featureEvents)
          .where(eq(featureEvents.featureId, feature.id))
          .orderBy(asc(featureEvents.at)),
        db(c, ctx).select().from(stages).where(eq(stages.pipelineId, feature.pipelineId)),
      ]);
      const nameOf = (id: string | null) =>
        id ? (stageRows.find((s) => s.id === id)?.name ?? "unknown") : "Backlog";

      const lines = rows.map((row) => {
        const when = row.at.toISOString();
        /**
         * A null destination is two different stories, and the trigger
         * tells them apart: a backward move went to the backlog, a
         * forward one left the last stage, which is finishing. Reading
         * both as "to Backlog" told a finished card's history exactly
         * backwards.
         */
        const description =
          row.kind === "stage_moved"
            ? !row.toStageId && row.fromStageId && !row.trigger.endsWith("_back")
              ? `finished ${nameOf(row.fromStageId)}`
              : `${nameOf(row.fromStageId)} to ${nameOf(row.toStageId)}`
            : `${row.fromStatus ?? "new"} to ${row.toStatus ?? "unknown"}`;
        return `event|${when}|${row.kind}|${TRIGGER_WORDS[row.trigger] ?? row.trigger}|${description}`;
      });
      return c.text(lines.join("\n"));
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
