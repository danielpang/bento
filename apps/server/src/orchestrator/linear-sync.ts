import { and, asc, eq, isNull } from "drizzle-orm";
import { features, linearConnections, linearIssueLinks, linearTeamMappings, stages } from "@bento/db";
import type { LinearClient, LinearWebhookIssue } from "@bento/linear";
import { captureJobErrors } from "../analytics.js";
import type { AppContext } from "../context.js";
import {
  importLinearIssue,
  linearConnectionFor,
  linearConnectionRow,
  resolveIssueTarget,
  resolveTeamState,
  stateTypeForStatus,
} from "../linear.js";

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
  // A pending link names an issue that may not exist yet. The filing
  // job pushes the card's current state itself once it lands.
  if (!link || link.stale || link.pending) return;

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

/**
 * Files the Linear issue for a card created in Bento, and links the two
 * so every later transition follows the outbound path.
 *
 * The order is reserve, file, confirm, and it is that way because the
 * middle step is an external call that cannot be undone:
 *
 * 1. A pending link row claims the issue id this job is about to ask
 *    Linear for. Bento chooses that id rather than reading one back, so
 *    the claim can be made before Linear knows anything.
 * 2. Linear is asked to create the issue under that id. Asking twice is
 *    refused rather than granted, so a retry cannot produce a second
 *    issue, and if the first attempt did file one before dying the
 *    retry recovers it by id.
 * 3. The link is confirmed with the identifier and url Linear assigned.
 *
 * The reservation also settles the race with Linear's own webhook: the
 * create event for this issue can arrive before step 3, and inbound
 * import is keyed on the issue id, which the pending row already holds.
 * Without it, Bento imports the issue it just filed as a second card.
 *
 * A card imported from Linear already has a link and is left alone.
 */
export async function handleLinearIssueCreate(
  ctx: AppContext,
  job: { featureId: string },
): Promise<void> {
  // The enqueue is deferred until the creating request commits, so a
  // feature that is not here has been deleted since.
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, job.featureId)).limit(1);
  if (!feature) return;

  const [existing] = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.featureId, feature.id))
    .limit(1);
  if (existing && !existing.pending) return;

  const connection = await linearConnectionFor(ctx, feature.organizationId);
  if (!connection) return;

  const [mapping] = await ctx.db
    .select({ linearTeamId: linearTeamMappings.linearTeamId })
    .from(linearTeamMappings)
    .where(
      and(
        mappingOrgFilter(feature.organizationId),
        eq(linearTeamMappings.projectId, feature.projectId),
      ),
    )
    // Nothing stops two Linear teams mapping to one project, and an
    // arbitrary row would mean an arbitrary team. The first mapping made
    // wins, every time.
    .orderBy(asc(linearTeamMappings.createdAt), asc(linearTeamMappings.id))
    .limit(1);

  // A reservation already chose a team, and the issue it stands for may
  // already exist in it, so a retry keeps that choice even if the
  // mappings moved underneath it.
  const target = resolveIssueTarget(
    connection.connection,
    existing?.linearTeamId ?? mapping?.linearTeamId ?? null,
  );
  if (!target) return;

  // The card's own id, so the reservation and the retry agree on it
  // without storing anything extra. Linear ids are UUIDs, and so is this.
  const issueId = existing?.linearIssueId ?? feature.id;

  if (!existing) {
    // lastOutboundStateType stays null: Linear chooses the state, not
    // us, so there is nothing yet for the echo check to recognize.
    const reserved = await ctx.db
      .insert(linearIssueLinks)
      .values({
        featureId: feature.id,
        linearIssueId: issueId,
        linearIssueIdentifier: "",
        linearIssueUrl: "",
        linearTeamId: target.teamId,
        pending: true,
      })
      .onConflictDoNothing()
      .returning({ id: linearIssueLinks.id });
    // Another attempt reserved it first; let that one finish.
    if (!reserved.length) return;
  }

  const issue = await fileIssue(connection.client, issueId, {
    teamId: target.teamId,
    title: feature.title,
    description: feature.description || undefined,
    projectId: target.projectId ?? undefined,
  });

  await ctx.db
    .update(linearIssueLinks)
    .set({
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url,
      pending: false,
      updatedAt: new Date(),
    })
    .where(eq(linearIssueLinks.featureId, feature.id));

  // The card may have started while this job waited its turn, and the
  // transitions it made in the meantime found no link to push through.
  const [current] = await ctx.db
    .select({ status: features.status, currentStageId: features.currentStageId })
    .from(features)
    .where(eq(features.id, feature.id))
    .limit(1);
  if (current && current.status !== "backlog") {
    await queueLinearOutbound(ctx, {
      featureId: feature.id,
      toStatus: current.status,
      toStageId: current.currentStageId,
    });
  }
}

/**
 * Creates the issue, or adopts the one an earlier attempt already filed
 * under this id.
 *
 * Which of those two happened is not something an error message can be
 * trusted to report, so the id is asked for directly instead. Only this
 * path files an issue under a card's id, so an issue that answers to it
 * is the one this job was trying to make.
 */
async function fileIssue(
  client: LinearClient,
  id: string,
  input: { teamId: string; title: string; description?: string | undefined; projectId?: string | undefined },
): Promise<{ identifier: string; url: string }> {
  try {
    return await client.createIssue({ id, ...input });
  } catch (err) {
    const already = await client.issue(id).catch(() => null);
    if (already) return already;
    throw err;
  }
}

/**
 * Called from the create card route. The connection check keeps the
 * queue quiet for deployments with no Linear and for workspaces that
 * turned issue creation off.
 */
export async function queueLinearIssueCreate(
  ctx: AppContext,
  feature: { id: string; organizationId: string | null },
): Promise<void> {
  try {
    const connection = await linearConnectionRow(ctx, feature.organizationId);
    if (!connection?.createIssues) return;
    await ctx.boss.send("linear.create-issue", { featureId: feature.id });
  } catch (err) {
    // Filing the issue must never cost someone the card they just made.
    console.error(`linear.create-issue enqueue for ${feature.id} failed:`, err);
  }
}

/** Called from recordFeatureEvent; a quick link check keeps the queue quiet. */
export async function queueLinearOutbound(
  ctx: AppContext,
  event: { featureId: string; toStatus?: string | null | undefined; toStageId?: string | null | undefined },
): Promise<void> {
  try {
    const [link] = await ctx.db
      .select({ id: linearIssueLinks.id, pending: linearIssueLinks.pending })
      .from(linearIssueLinks)
      .where(eq(linearIssueLinks.featureId, event.featureId))
      .limit(1);
    if (!link || link.pending) return;
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
  await ctx.boss.createQueue("linear.create-issue");

  await ctx.boss.work<{ organizationId: string | null }>("linear.backlog-sync", async (jobs) => {
    for (const job of jobs) {
      try {
        await syncLinearBacklog(ctx, job.data.organizationId);
      } catch (err) {
        console.error("linear.backlog-sync failed:", err);
        ctx.analytics?.captureException(err, null, null, { queue: "linear.backlog-sync" });
        throw err;
      }
    }
  });

  // Webhook fallback: deployments Linear cannot reach still converge.
  await ctx.boss.createQueue("linear.sweep");
  await ctx.boss.schedule("linear.sweep", "*/15 * * * *");
  await ctx.boss.work("linear.sweep", captureJobErrors(ctx.analytics, "linear.sweep", async () => {
    for (const organizationId of await linearConnectedOrgs(ctx)) {
      await ctx.boss.send("linear.backlog-sync", { organizationId });
    }
  }));

  await ctx.boss.work<Parameters<typeof handleLinearInbound>[1]>("linear.inbound", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleLinearInbound(ctx, job.data);
      } catch (err) {
        console.error("linear.inbound failed:", err);
        ctx.analytics?.captureException(err, null, null, { queue: "linear.inbound" });
        throw err;
      }
    }
  });

  await ctx.boss.work<Parameters<typeof handleLinearIssueCreate>[1]>("linear.create-issue", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleLinearIssueCreate(ctx, job.data);
      } catch (err) {
        console.error(`linear.create-issue ${job.data.featureId} failed:`, err);
        ctx.analytics?.captureException(err, null, null, { queue: "linear.create-issue", feature_id: job.data.featureId });
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
        ctx.analytics?.captureException(err, null, null, { queue: "linear.outbound", feature_id: job.data.featureId });
        throw err;
      }
    }
  });
}
