import { and, eq, isNull } from "drizzle-orm";
import { features, linearConnections, linearIssueLinks, linearTeamMappings, stages } from "@bento/db";
import type { LinearWebhookIssue } from "@bento/linear";
import type { AppContext } from "../context.js";
import { importLinearIssue, linearConnectionFor, resolveTeamState, stateTypeForStatus } from "../linear.js";

const BENTO_LABEL = "bento";

function linkOrgFilter(organizationId: string | null) {
  return organizationId
    ? eq(linearIssueLinks.organizationId, organizationId)
    : isNull(linearIssueLinks.organizationId);
}

function mappingOrgFilter(organizationId: string | null) {
  return organizationId
    ? eq(linearTeamMappings.organizationId, organizationId)
    : isNull(linearTeamMappings.organizationId);
}

/**
 * Pulls each mapped team's backlog into its project. Runs from Sync now
 * and from the cron sweep, which is what keeps deployments without a
 * reachable webhook (local mode above all) in step.
 */
export async function syncLinearBacklog(ctx: AppContext, organizationId: string | null): Promise<number> {
  const connection = await linearConnectionFor(ctx, organizationId);
  if (!connection) return 0;
  const mappings = await ctx.db
    .select()
    .from(linearTeamMappings)
    .where(mappingOrgFilter(organizationId));

  let imported = 0;
  for (const mapping of mappings) {
    let after: string | undefined;
    // Bounded paging so one enormous backlog cannot pin the worker.
    for (let page = 0; page < 20; page += 1) {
      const result = await connection.client.issues({
        teamId: mapping.linearTeamId,
        stateTypes: ["backlog", "unstarted"],
        after,
      });
      for (const issue of result.issues) {
        const featureId = await importLinearIssue(ctx, {
          organizationId,
          projectId: mapping.projectId,
          issue,
        });
        if (featureId) imported += 1;
      }
      if (!result.hasNextPage || !result.endCursor) break;
      after = result.endCursor;
    }
  }
  return imported;
}

/** Every tenant with a connection, for the cron sweep. */
export async function linearConnectedOrgs(ctx: AppContext): Promise<(string | null)[]> {
  const rows = await ctx.db
    .select({ organizationId: linearConnections.organizationId })
    .from(linearConnections);
  return rows.map((row) => row.organizationId);
}

/**
 * Applies one verified webhook event. Import rules match the sweep: a
 * mapped team's new backlog issue comes in on its own, and the bento
 * label pulls in anything else the mapping or default project can
 * place. Updates only touch the title, plus the echo check that keeps
 * our own state pushes from bouncing back as inbound changes.
 */
export async function handleLinearInbound(
  ctx: AppContext,
  job: { organizationId: string | null; action: "create" | "update" | "remove"; issue: LinearWebhookIssue },
): Promise<void> {
  const { organizationId, action, issue } = job;

  const [link] = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(and(linkOrgFilter(organizationId), eq(linearIssueLinks.linearIssueId, issue.id)))
    .limit(1);

  if (action === "remove") {
    if (link) {
      await ctx.db
        .update(linearIssueLinks)
        .set({ stale: true, updatedAt: new Date() })
        .where(eq(linearIssueLinks.id, link.id));
    }
    return;
  }

  if (link) {
    const echo = issue.state?.type && issue.state.type === link.lastOutboundStateType;
    if (!echo && issue.title) {
      await ctx.db
        .update(features)
        .set({ title: issue.title, updatedAt: new Date() })
        .where(eq(features.id, link.featureId));
    }
    await ctx.db
      .update(linearIssueLinks)
      .set({ lastInboundUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(linearIssueLinks.id, link.id));
    return;
  }

  // Unlinked issue: decide whether this event imports it.
  if (!issue.title || !issue.identifier || !issue.url || !issue.teamId) return;
  const [mapping] = await ctx.db
    .select()
    .from(linearTeamMappings)
    .where(and(mappingOrgFilter(organizationId), eq(linearTeamMappings.linearTeamId, issue.teamId)))
    .limit(1);

  const hasBentoLabel = (issue.labels ?? []).some((label) => label.name.toLowerCase() === BENTO_LABEL);
  const isBacklogState = !issue.state || issue.state.type === "backlog" || issue.state.type === "unstarted";

  let projectId: string | null = null;
  if (hasBentoLabel) {
    projectId = mapping?.projectId ?? (await defaultProjectFor(ctx, organizationId));
  } else if (mapping && action === "create" && isBacklogState) {
    projectId = mapping.projectId;
  }
  if (!projectId) return;

  await importLinearIssue(ctx, {
    organizationId,
    projectId,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? null,
      teamId: issue.teamId,
    },
  });
}

async function defaultProjectFor(ctx: AppContext, organizationId: string | null): Promise<string | null> {
  const [row] = await ctx.db
    .select({ defaultProjectId: linearConnections.defaultProjectId })
    .from(linearConnections)
    .where(
      organizationId
        ? eq(linearConnections.organizationId, organizationId)
        : isNull(linearConnections.organizationId),
    )
    .limit(1);
  return row?.defaultProjectId ?? null;
}

/**
 * Pushes one Bento transition out to the linked Linear issue: the
 * mapped workflow state when it changed, and a comment naming where the
 * card went. lastOutboundStateType is written first thing after the
 * state push so the webhook echo is recognized when it arrives.
 */
export async function handleLinearOutbound(
  ctx: AppContext,
  job: { featureId: string; toStatus?: string | null; toStageId?: string | null },
): Promise<void> {
  const [link] = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.featureId, job.featureId))
    .limit(1);
  if (!link || link.stale) return;

  const connection = await linearConnectionFor(ctx, link.organizationId);
  if (!connection) return;

  const [feature] = await ctx.db.select().from(features).where(eq(features.id, job.featureId)).limit(1);
  if (!feature) return;

  const status = job.toStatus ?? feature.status;
  const targetType = stateTypeForStatus(status);

  if (targetType && targetType !== link.lastOutboundStateType && link.linearTeamId) {
    const state = await resolveTeamState(connection.client, link.linearTeamId, targetType);
    if (state) {
      await connection.client.updateIssueState(link.linearIssueId, state.id);
    }
    await ctx.db
      .update(linearIssueLinks)
      .set({ lastOutboundStateType: targetType, updatedAt: new Date() })
      .where(eq(linearIssueLinks.id, link.id));
  }

  let stageName: string | null = null;
  if (job.toStageId) {
    const [stage] = await ctx.db
      .select({ name: stages.name })
      .from(stages)
      .where(eq(stages.id, job.toStageId))
      .limit(1);
    stageName = stage?.name ?? null;
  }
  const comment = stageName
    ? `Bento moved this card to the ${stageName} stage.`
    : status === "done"
      // Not "every stage is complete": a card can be marked done from
      // any stage, so the sentence has to be true of that card too.
      ? "Bento finished this card."
      : status === "cancelled"
        ? "Bento cancelled this card."
        : status === "backlog"
          ? "Bento returned this card to the backlog."
          : null;
  if (comment) {
    await connection.client.createComment(link.linearIssueId, comment);
  }
}

/** Called from recordFeatureEvent; a quick link check keeps the queue quiet. */
export async function queueLinearOutbound(
  ctx: AppContext,
  event: { featureId: string; toStatus?: string | null | undefined; toStageId?: string | null | undefined },
): Promise<void> {
  try {
    const [link] = await ctx.db
      .select({ id: linearIssueLinks.id })
      .from(linearIssueLinks)
      .where(eq(linearIssueLinks.featureId, event.featureId))
      .limit(1);
    if (!link) return;
    await ctx.boss.send("linear.outbound", {
      featureId: event.featureId,
      toStatus: event.toStatus ?? null,
      toStageId: event.toStageId ?? null,
    });
  } catch (err) {
    // Linear mirroring must never block the board transition itself.
    console.error(`linear.outbound enqueue for ${event.featureId} failed:`, err);
  }
}

export async function registerLinearJobs(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue("linear.backlog-sync");
  await ctx.boss.createQueue("linear.inbound");
  await ctx.boss.createQueue("linear.outbound");

  await ctx.boss.work<{ organizationId: string | null }>("linear.backlog-sync", async (jobs) => {
    for (const job of jobs) {
      try {
        await syncLinearBacklog(ctx, job.data.organizationId);
      } catch (err) {
        console.error("linear.backlog-sync failed:", err);
        throw err;
      }
    }
  });

  // Webhook fallback: deployments Linear cannot reach still converge.
  await ctx.boss.createQueue("linear.sweep");
  await ctx.boss.schedule("linear.sweep", "*/15 * * * *");
  await ctx.boss.work("linear.sweep", async () => {
    for (const organizationId of await linearConnectedOrgs(ctx)) {
      await ctx.boss.send("linear.backlog-sync", { organizationId });
    }
  });

  await ctx.boss.work<Parameters<typeof handleLinearInbound>[1]>("linear.inbound", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleLinearInbound(ctx, job.data);
      } catch (err) {
        console.error("linear.inbound failed:", err);
        throw err;
      }
    }
  });

  await ctx.boss.work<Parameters<typeof handleLinearOutbound>[1]>("linear.outbound", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleLinearOutbound(ctx, job.data);
      } catch (err) {
        console.error(`linear.outbound ${job.data.featureId} failed:`, err);
        throw err;
      }
    }
  });
}
