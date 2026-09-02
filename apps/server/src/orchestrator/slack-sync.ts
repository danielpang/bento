import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  agentProfiles,
  features,
  member,
  pipelines,
  projects,
  seedDefaultPipeline,
  slackPendingMentions,
  slackThreadLinks,
  slackUserSettings,
  stages,
  user,
} from "@bento/db";
import { mentionTitle } from "@bento/slack";
import type { AppContext } from "../context.js";
import { LOCAL_USER_ID } from "../context.js";
import {
  cardUrl,
  slackClientFor,
  slackConnectionByTeam,
} from "../slack.js";
import { queueLinearIssueCreate } from "./linear-sync.js";
import {
  activationRefusal,
  advanceFeature,
  moveFeatureBack,
  recordManualApproval,
  recordRejection,
} from "./gate-evaluator.js";
import {
  chooseSlackProject,
  handleSlackNotify,
  isUuid,
  projectPickerBlocks,
  queueSlackNotify,
  type SlackNotifyJob,
} from "./slack-notify.js";

const PENDING_TTL_MS = 30 * 60_000;
const UNKNOWN_MEMBER =
  "Bento could not match your Slack email to a team member. Check that your Slack and Bento emails match, then try again.";
const NEED_ACCOUNT = "You need a Bento account on this team to approve.";

export type SlackInboundJob =
  | {
      kind: "mention";
      teamId: string;
      channelId: string;
      userId: string;
      text: string;
      ts: string;
      threadTs: string;
    }
  | {
      kind: "pick_project";
      teamId: string;
      channelId: string;
      userId: string;
      pendingId: string;
      projectId: string;
    }
  | {
      kind: "approve";
      teamId: string;
      channelId: string;
      userId: string;
      featureId: string;
      stageId: string;
      messageTs: string;
    }
  | {
      kind: "reject";
      teamId: string;
      channelId: string;
      userId: string;
      featureId: string;
      stageId: string;
      messageTs: string;
      reason: string;
    };

type ResolvedMember = {
  userId: string;
  organizationId: string | null;
  defaultProjectId: string | null;
};

type SlackCardCreate = "created" | "exists";

export async function handleSlackInbound(ctx: AppContext, job: SlackInboundJob): Promise<void> {
  const connection = await slackConnectionByTeam(ctx, job.teamId);
  if (!connection) return;
  const client = await slackClientFor(ctx, connection);
  if (!client) return;

  if (job.kind === "mention") {
    await handleMention(ctx, job, connection.botUserId, connection.organizationId, client);
    return;
  }
  if (job.kind === "pick_project") {
    await handlePickProject(ctx, job, connection.organizationId, client);
    return;
  }
  if (job.kind === "approve") {
    await handleApprove(ctx, job, connection.organizationId, client);
    return;
  }
  await handleReject(ctx, job, connection.organizationId, client);
}

async function handleMention(
  ctx: AppContext,
  job: Extract<SlackInboundJob, { kind: "mention" }>,
  botUserId: string,
  organizationId: string | null,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
): Promise<void> {
  const memberRow = await resolveSlackMember(ctx, organizationId, job.userId, client);
  if (!memberRow) {
    await client.postMessage({
      channel: job.channelId,
      threadTs: job.threadTs,
      text: UNKNOWN_MEMBER,
    });
    return;
  }
  const title = mentionTitle(job.text, botUserId);
  if (!title) {
    await client.postMessage({
      channel: job.channelId,
      threadTs: job.threadTs,
      text: "Say what the card is for after @bento, for example @bento add dark mode.",
    });
    return;
  }

  const claimed = await claimMention(ctx, {
    organizationId: memberRow.organizationId,
    teamId: job.teamId,
    userId: job.userId,
    channelId: job.channelId,
    threadTs: job.threadTs,
    title,
    description: slackDescription(job.channelId, job.ts),
  });
  if (!claimed) return;

  const defaultProjectId = await loadDefaultProject(ctx, memberRow);
  const options = await listMemberProjects(ctx, memberRow);
  const projectId = chooseSlackProject(defaultProjectId, options);
  if (projectId) {
    await createSlackCard(ctx, {
      organizationId: memberRow.organizationId,
      userId: memberRow.userId,
      projectId,
      title: claimed.pending.title,
      description: claimed.pending.description,
      teamId: job.teamId,
      channelId: job.channelId,
      threadTs: job.threadTs,
      slackUserId: job.userId,
      client,
    });
    await ctx.db.delete(slackPendingMentions).where(eq(slackPendingMentions.id, claimed.pending.id));
    return;
  }

  if (options.length === 0) {
    await ctx.db.delete(slackPendingMentions).where(eq(slackPendingMentions.id, claimed.pending.id));
    await client.postMessage({
      channel: job.channelId,
      threadTs: job.threadTs,
      text: "This team has no projects yet. Create one in Bento, then try again.",
    });
    return;
  }

  if (!claimed.isNew) {
    await client.postEphemeral({
      channel: job.channelId,
      user: job.userId,
      text: "Pick a project on the message above. You can also set a default project in Bento Settings under Slack.",
    });
    return;
  }

  if (defaultProjectId) {
    console.warn(
      `slack mention ignored default project ${defaultProjectId} for user ${memberRow.userId}: not in this team's project list`,
    );
  }

  await client.postMessage({
    channel: job.channelId,
    threadTs: job.threadTs,
    text: "Which project should this card go to?",
    blocks: projectPickerBlocks(claimed.pending.id, options),
  });
}

async function handlePickProject(
  ctx: AppContext,
  job: Extract<SlackInboundJob, { kind: "pick_project" }>,
  organizationId: string | null,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
): Promise<void> {
  const memberRow = await resolveSlackMember(ctx, organizationId, job.userId, client);
  if (!memberRow) {
    await client.postEphemeral({ channel: job.channelId, user: job.userId, text: UNKNOWN_MEMBER });
    return;
  }
  const pending = await loadPending(ctx, job);
  if (!pending || pending.slackUserId !== job.userId) {
    await client.postEphemeral({
      channel: job.channelId || pending?.slackChannelId || "",
      user: job.userId,
      text: "That project picker has expired. Tag @bento again.",
    });
    return;
  }
  const channelId = pending.slackChannelId || job.channelId;
  if (!(await memberCanUseProject(ctx, job.projectId, memberRow))) {
    await client.postEphemeral({
      channel: channelId,
      user: job.userId,
      text: "That project is not on this team.",
    });
    return;
  }
  try {
    await createSlackCard(ctx, {
      organizationId: memberRow.organizationId,
      userId: memberRow.userId,
      projectId: job.projectId,
      title: pending.title,
      description: pending.description,
      teamId: job.teamId || pending.slackTeamId,
      channelId: pending.slackChannelId,
      threadTs: pending.slackThreadTs,
      slackUserId: job.userId,
      client,
    });
  } catch (err) {
    console.error("slack pick_project failed:", err);
    await client.postEphemeral({
      channel: channelId,
      user: job.userId,
      text: "Could not create that card. Try tagging @bento again.",
    });
    return;
  }
  await ctx.db
    .delete(slackPendingMentions)
    .where(and(eq(slackPendingMentions.id, pending.id), eq(slackPendingMentions.slackUserId, job.userId)));
}

async function handleApprove(
  ctx: AppContext,
  job: Extract<SlackInboundJob, { kind: "approve" }>,
  organizationId: string | null,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
): Promise<void> {
  const memberRow = await resolveSlackMember(ctx, organizationId, job.userId, client);
  if (!memberRow) {
    await client.postEphemeral({ channel: job.channelId, user: job.userId, text: NEED_ACCOUNT });
    return;
  }
  const feature = await accessibleFeature(ctx, job.featureId, memberRow.organizationId);
  if (!feature?.currentStageId) {
    await client.postEphemeral({ channel: job.channelId, user: job.userId, text: NEED_ACCOUNT });
    return;
  }
  if (feature.status === "done" || feature.status === "cancelled" || feature.currentStageId !== job.stageId) {
    await client.postEphemeral({
      channel: job.channelId,
      user: job.userId,
      text: "This card is no longer waiting for review.",
    });
    return;
  }
  await recordManualApproval(ctx, feature.id, feature.currentStageId);
  await advanceFeature(ctx, feature.id, "manual", memberRow.userId, feature.currentStageId);
  await updateReviewMessage(ctx, client, job, "Approved.");
}

async function handleReject(
  ctx: AppContext,
  job: Extract<SlackInboundJob, { kind: "reject" }>,
  organizationId: string | null,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
): Promise<void> {
  const memberRow = await resolveSlackMember(ctx, organizationId, job.userId, client);
  if (!memberRow) {
    await client.postEphemeral({ channel: job.channelId, user: job.userId, text: NEED_ACCOUNT });
    return;
  }
  const feature = await accessibleFeature(ctx, job.featureId, memberRow.organizationId);
  if (!feature?.currentStageId) {
    await client.postEphemeral({ channel: job.channelId, user: job.userId, text: NEED_ACCOUNT });
    return;
  }
  if (feature.status === "done" || feature.status === "cancelled" || feature.currentStageId !== job.stageId) {
    await client.postEphemeral({
      channel: job.channelId,
      user: job.userId,
      text: "This card is no longer waiting for review.",
    });
    return;
  }
  await recordRejection(ctx, feature.id, feature.currentStageId, job.reason.slice(0, 500) || undefined);
  await moveFeatureBack(ctx, feature.id, "manual", memberRow.userId);
  await updateReviewMessage(ctx, client, job, "Rejected.");
}

async function updateReviewMessage(
  ctx: AppContext,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
  job: { featureId: string; channelId: string; messageTs: string },
  text: string,
): Promise<void> {
  try {
    await client.updateMessage({
      channel: job.channelId,
      ts: job.messageTs,
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "open_card",
              text: { type: "plain_text", text: "Open card" },
              url: cardUrl(ctx, job.featureId),
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error(`slack review update for ${job.featureId} failed:`, err);
    return;
  }
  await ctx.db
    .update(slackThreadLinks)
    .set({ reviewMessageTs: null, updatedAt: new Date() })
    .where(eq(slackThreadLinks.featureId, job.featureId));
}

async function createSlackCard(
  ctx: AppContext,
  input: {
    organizationId: string | null;
    userId: string;
    projectId: string;
    title: string;
    description: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    slackUserId: string;
    client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>;
  },
): Promise<SlackCardCreate> {
  const existingLink = await ctx.db
    .select({ id: slackThreadLinks.id })
    .from(slackThreadLinks)
    .where(
      and(
        eq(slackThreadLinks.slackTeamId, input.teamId),
        eq(slackThreadLinks.slackChannelId, input.channelId),
        eq(slackThreadLinks.slackThreadTs, input.threadTs),
      ),
    )
    .limit(1);
  if (existingLink[0]) return "exists";

  const pipelineId = await ensureProjectPipeline(ctx, input.projectId);
  const [feature] = await ctx.db
    .insert(features)
    .values({
      projectId: input.projectId,
      pipelineId,
      title: input.title,
      description: input.description,
    })
    .returning();
  if (!feature) throw new Error("feature insert returned no row");
  try {
    await ctx.db.insert(slackThreadLinks).values({
      featureId: feature.id,
      slackTeamId: input.teamId,
      slackChannelId: input.channelId,
      slackThreadTs: input.threadTs,
      slackUserId: input.slackUserId,
    });
  } catch {
    await ctx.db.delete(features).where(eq(features.id, feature.id));
    return "exists";
  }
  await queueLinearIssueCreate(ctx, feature);
  const setupNote = await slackSetupGap(ctx, pipelineId, {
    userId: input.userId,
    organizationId: input.organizationId,
  });
  await queueSlackNotify(ctx, { type: "created", featureId: feature.id, ...(setupNote ? { setupNote } : {}) });
  const refused = await activationRefusal(ctx, feature);
  if (refused) {
    await input.client.postMessage({
      channel: input.channelId,
      threadTs: input.threadTs,
      text: refused,
    });
    return "created";
  }
  await advanceFeature(ctx, feature.id, "manual", input.userId);
  return "created";
}

async function ensureProjectPipeline(ctx: AppContext, projectId: string): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.projectId, projectId))
    .limit(1);
  if (existing) return existing.id;
  return seedDefaultPipeline(ctx.db, projectId);
}

/**
 * Missing stages or agents are a setup gap, not a failed mention. The
 * card still belongs on the board; Slack tells the person what to
 * finish in Bento so the card can run.
 */
async function slackSetupGap(
  ctx: AppContext,
  pipelineId: string,
  memberRow: { userId: string; organizationId: string | null },
): Promise<string | null> {
  const stageRows = await ctx.db
    .select({ id: stages.id, defaultAgentProfileId: stages.defaultAgentProfileId })
    .from(stages)
    .where(eq(stages.pipelineId, pipelineId))
    .orderBy(asc(stages.position));
  if (stageRows.length === 0) {
    return "This project has no pipeline stages yet. Add stages in Bento, then open the card to start it.";
  }
  const agentWhere = memberRow.organizationId
    ? eq(agentProfiles.organizationId, memberRow.organizationId)
    : eq(agentProfiles.ownerId, memberRow.userId);
  const [agent] = await ctx.db.select({ id: agentProfiles.id }).from(agentProfiles).where(agentWhere).limit(1);
  if (!agent) {
    return "No agents are set up yet, so nothing will run. Create an agent in Bento and assign it to a stage, then open the card to start it.";
  }
  if (!stageRows[0]?.defaultAgentProfileId) {
    return "The first stage has no agent, so nothing will run. Assign one in Bento, then open the card to start it.";
  }
  return null;
}

async function claimMention(
  ctx: AppContext,
  input: {
    organizationId: string | null;
    teamId: string;
    userId: string;
    channelId: string;
    threadTs: string;
    title: string;
    description: string;
  },
): Promise<{ pending: typeof slackPendingMentions.$inferSelect; isNew: boolean } | null> {
  const [linked] = await ctx.db
    .select({ id: slackThreadLinks.id })
    .from(slackThreadLinks)
    .where(
      and(
        eq(slackThreadLinks.slackTeamId, input.teamId),
        eq(slackThreadLinks.slackChannelId, input.channelId),
        eq(slackThreadLinks.slackThreadTs, input.threadTs),
      ),
    )
    .limit(1);
  if (linked) return null;
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  const [inserted] = await ctx.db
    .insert(slackPendingMentions)
    .values({
      organizationId: input.organizationId,
      slackTeamId: input.teamId,
      slackUserId: input.userId,
      slackChannelId: input.channelId,
      slackThreadTs: input.threadTs,
      title: input.title,
      description: input.description,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { pending: inserted, isNew: true };

  const [existing] = await ctx.db
    .select()
    .from(slackPendingMentions)
    .where(
      and(
        eq(slackPendingMentions.slackTeamId, input.teamId),
        eq(slackPendingMentions.slackChannelId, input.channelId),
        eq(slackPendingMentions.slackThreadTs, input.threadTs),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const [updated] = await ctx.db
    .update(slackPendingMentions)
    .set({
      title: input.title,
      description: input.description,
      slackUserId: input.userId,
      expiresAt,
    })
    .where(eq(slackPendingMentions.id, existing.id))
    .returning();
  return { pending: updated ?? existing, isNew: false };
}

/**
 * Settings writes the default by (org, user). The first Slack lookup
 * is by Slack user id. Re-read by user id so a default saved in the
 * console is the one @bento uses, even when those rows were created
 * in a different order.
 */
async function loadDefaultProject(
  ctx: AppContext,
  memberRow: ResolvedMember,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ defaultProjectId: slackUserSettings.defaultProjectId })
    .from(slackUserSettings)
    .where(and(settingsOrgFilter(memberRow.organizationId), eq(slackUserSettings.userId, memberRow.userId)))
    .limit(1);
  return row?.defaultProjectId ?? memberRow.defaultProjectId;
}

/**
 * Slack user to Bento member. Prefers a stored slack user id so later
 * lookups do not depend on Slack still exposing the email.
 */
export async function resolveSlackMember(
  ctx: AppContext,
  organizationId: string | null,
  slackUserId: string,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
): Promise<ResolvedMember | null> {
  const [bySlack] = await ctx.db
    .select()
    .from(slackUserSettings)
    .where(
      and(
        settingsOrgFilter(organizationId),
        eq(slackUserSettings.slackUserId, slackUserId),
      ),
    )
    .limit(1);
  if (bySlack) {
    return {
      userId: bySlack.userId,
      organizationId: bySlack.organizationId,
      defaultProjectId: bySlack.defaultProjectId,
    };
  }

  const info = await client.usersInfo(slackUserId);
  const email = info?.email?.trim().toLowerCase();
  if (!email) return null;

  const matched = organizationId
    ? await memberByEmail(ctx, organizationId, email)
    : await localUserByEmail(ctx, email);
  if (!matched) return null;

  const [existing] = await ctx.db
    .select()
    .from(slackUserSettings)
    .where(and(settingsOrgFilter(matched.organizationId), eq(slackUserSettings.userId, matched.userId)))
    .limit(1);
  if (existing) {
    await ctx.db
      .update(slackUserSettings)
      .set({ slackUserId, updatedAt: new Date() })
      .where(eq(slackUserSettings.id, existing.id));
    return {
      userId: existing.userId,
      organizationId: existing.organizationId,
      defaultProjectId: existing.defaultProjectId,
    };
  }
  await ctx.db.insert(slackUserSettings).values({
    organizationId: matched.organizationId,
    userId: matched.userId,
    slackUserId,
  });
  return { ...matched, defaultProjectId: null };
}

async function memberByEmail(
  ctx: AppContext,
  organizationId: string,
  email: string,
): Promise<ResolvedMember | null> {
  const [row] = await ctx.db
    .select({ userId: user.id })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.organizationId, organizationId), sql`lower(${user.email}) = ${email}`))
    .limit(1);
  return row ? { userId: row.userId, organizationId, defaultProjectId: null } : null;
}

async function localUserByEmail(ctx: AppContext, email: string): Promise<ResolvedMember | null> {
  const [row] = await ctx.db
    .select({ userId: user.id })
    .from(user)
    .where(and(eq(user.id, LOCAL_USER_ID), sql`lower(${user.email}) = ${email}`))
    .limit(1);
  return row ? { userId: row.userId, organizationId: null, defaultProjectId: null } : null;
}

function settingsOrgFilter(organizationId: string | null) {
  return organizationId
    ? eq(slackUserSettings.organizationId, organizationId)
    : isNull(slackUserSettings.organizationId);
}

async function loadPending(
  ctx: AppContext,
  job: { pendingId: string; userId: string; teamId: string; channelId: string },
) {
  const now = new Date();
  if (isUuid(job.pendingId)) {
    const [byId] = await ctx.db
      .select()
      .from(slackPendingMentions)
      .where(and(eq(slackPendingMentions.id, job.pendingId), gt(slackPendingMentions.expiresAt, now)))
      .limit(1);
    if (byId) return byId;
  }
  if (!job.channelId) return null;
  const [byThread] = await ctx.db
    .select()
    .from(slackPendingMentions)
    .where(
      and(
        eq(slackPendingMentions.slackTeamId, job.teamId),
        eq(slackPendingMentions.slackChannelId, job.channelId),
        eq(slackPendingMentions.slackUserId, job.userId),
        gt(slackPendingMentions.expiresAt, now),
      ),
    )
    .limit(1);
  return byThread ?? null;
}

/**
 * Same reach as Settings' default-project dropdown: org projects this
 * member can see, plus org-less projects they still own. A default
 * saved in Settings that @bento then refused is how the picker showed
 * up after someone had already chosen.
 */
async function memberCanUseProject(
  ctx: AppContext,
  projectId: string,
  memberRow: ResolvedMember,
): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return false;
  if (!project.organizationId) return project.ownerId === memberRow.userId;
  if (project.organizationId === memberRow.organizationId) return true;
  if (!memberRow.organizationId) return false;
  const [membership] = await ctx.db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, memberRow.userId), eq(member.organizationId, project.organizationId)))
    .limit(1);
  return Boolean(membership);
}

async function listMemberProjects(
  ctx: AppContext,
  memberRow: ResolvedMember,
): Promise<{ id: string; name: string }[]> {
  const ownedOrgless = and(eq(projects.ownerId, memberRow.userId), isNull(projects.organizationId));
  const where = memberRow.organizationId
    ? or(eq(projects.organizationId, memberRow.organizationId), ownedOrgless)
    : ownedOrgless;
  if (!where) return [];
  return ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(where)
    .orderBy(asc(projects.name));
}

async function accessibleFeature(
  ctx: AppContext,
  featureId: string,
  organizationId: string | null,
) {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId)).limit(1);
  if (!feature) return null;
  if (organizationId) return feature.organizationId === organizationId ? feature : null;
  return feature.organizationId === null ? feature : null;
}

function slackDescription(channelId: string, ts: string): string {
  const permalink = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return `Created from Slack: ${permalink}`;
}

export async function registerSlackJobs(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue("slack.inbound");
  await ctx.boss.createQueue("slack.notify");

  await ctx.boss.work<SlackInboundJob>("slack.inbound", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleSlackInbound(ctx, job.data);
      } catch (err) {
        console.error("slack.inbound failed:", err);
        ctx.analytics?.captureException(err, null, null, { queue: "slack.inbound" });
        throw err;
      }
    }
  });

  await ctx.boss.work<SlackNotifyJob>("slack.notify", async (jobs) => {
    for (const job of jobs) {
      try {
        await handleSlackNotify(ctx, job.data);
      } catch (err) {
        console.error(`slack.notify ${job.data.featureId} failed:`, err);
        ctx.analytics?.captureException(err, null, null, {
          queue: "slack.notify",
          feature_id: job.data.featureId,
        });
        throw err;
      }
    }
  });
}
