import { and, desc, eq } from "drizzle-orm";
import { stageArtifactPath } from "@bento/core";
import {
  agentRuns,
  features,
  gateChecks,
  projects,
  runArtifacts,
  runEvents,
  slackThreadLinks,
  stages,
} from "@bento/db";
import { markdownToMrkdwn, SlackApiError, truncateWriteUp, type SlackBlock } from "@bento/slack";
import type { AppContext } from "../context.js";
import { cardUrl, slackClientFor, slackConnectionByTeam, slackConnectionRow } from "../slack.js";

/** Slack errors that will not succeed on retry. Drop rather than loop. */
const PERMANENT_SLACK_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "account_inactive",
  "invalid_auth",
  "token_revoked",
  "ekm_access_denied",
  "cannot_reply_to_message",
]);

const NOTIFY_SEND_OPTIONS = { retryLimit: 8, retryDelay: 15, retryBackoff: true } as const;

export type SlackNotifyJob =
  | { type: "created"; featureId: string }
  | {
      type: "feature_event";
      featureId: string;
      kind: "stage_moved" | "status_changed";
      trigger: string;
      fromStageId: string | null;
      toStageId: string | null;
      fromStatus: string | null;
      toStatus: string | null;
    }
  | { type: "run_finished"; featureId: string; runId: string };

type ThreadLink = typeof slackThreadLinks.$inferSelect;

async function threadLinkFor(ctx: AppContext, featureId: string): Promise<ThreadLink | null> {
  const [link] = await ctx.db
    .select()
    .from(slackThreadLinks)
    .where(eq(slackThreadLinks.featureId, featureId))
    .limit(1);
  return link ?? null;
}

/**
 * Called from recordFeatureEvent and every run-finish path. A quick
 * link check keeps the queue quiet for cards that never came from Slack.
 *
 * Enqueue is retried here because the callers (a finished run, a gate
 * move) cannot themselves be retried without redoing work. The job's
 * own retryLimit covers Slack API failures after it is queued.
 */
export async function queueSlackNotify(ctx: AppContext, job: SlackNotifyJob): Promise<void> {
  const link = await threadLinkFor(ctx, job.featureId);
  if (!link) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ctx.boss.send("slack.notify", job, NOTIFY_SEND_OPTIONS);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(`slack.notify enqueue for ${job.featureId} failed:`, lastErr);
}

/**
 * Thread reply for a work run that ended. Judge runs are silent here:
 * their verdict shows up as a gate event (moved, or waiting with the
 * reason), and posting "the judge finished" would bury the work.
 */
export async function queueRunFinishedSlack(ctx: AppContext, runId: string): Promise<void> {
  const [run] = await ctx.db
    .select({ featureId: agentRuns.featureId, kind: agentRuns.kind })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run || run.kind === "judge") return;
  await queueSlackNotify(ctx, { type: "run_finished", featureId: run.featureId, runId });
}

/** A card that is already gated but whose reason just changed. */
export function gatedReasonJob(featureId: string, stageId: string): SlackNotifyJob {
  return {
    type: "feature_event",
    featureId,
    kind: "status_changed",
    trigger: "gate_auto",
    fromStageId: null,
    toStageId: stageId,
    fromStatus: "gated",
    toStatus: "gated",
  };
}

export async function handleSlackNotify(ctx: AppContext, job: SlackNotifyJob): Promise<void> {
  const link = await threadLinkFor(ctx, job.featureId);
  if (!link) return;
  const connection = await slackConnectionByTeam(ctx, link.slackTeamId)
    ?? await slackConnectionRow(ctx, link.organizationId);
  if (!connection) return;
  const client = await slackClientFor(ctx, connection);
  if (!client) return;

  const [feature] = await ctx.db.select().from(features).where(eq(features.id, job.featureId)).limit(1);
  if (!feature) return;
  const url = cardUrl(ctx, feature.id);

  const post = (text: string, blocks: SlackBlock[]) =>
    postThread(client, link, job.featureId, text, blocks);

  if (job.type === "created") {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId)).limit(1);
    const projectName = project?.name ?? "the project";
    const text = `Created *${feature.title}* in *${projectName}*.`;
    await post(text, [section(text), actions([urlButton("Open card", url)])]);
    return;
  }

  if (job.type === "run_finished") {
    const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, job.runId)).limit(1);
    if (!run) return;
    const stageName = await stageNameOf(ctx, run.stageId);
    if (run.status === "succeeded") {
      const writeUp = await stageWriteUp(ctx, run.id, run.stageId);
      const spoken = writeUp ?? (await lastAssistantText(ctx, run.id));
      const heading = `*${stageName}* finished.`;
      const body = spoken ? `\n${markdownToMrkdwn(truncateWriteUp(spoken))}` : "";
      await post(`${stageName} finished.`, [
        section(`${heading}${body}`),
        actions([urlButton("Open card", url)]),
      ]);
      return;
    }
    const error = run.error?.trim() ? `: ${run.error.trim().slice(0, 300)}` : ".";
    const text = `*${stageName}* failed${error}`;
    await post(text, [section(text), actions([urlButton("Open card", url)])]);
    return;
  }

  if (job.type !== "feature_event") return;

  // A card leaving the backlog is covered by the created message.
  if (job.kind === "stage_moved" && job.fromStageId === null) return;

  if (job.toStatus === "done") {
    await post("This card is finished.", [
      section("This card is finished."),
      actions([urlButton("Open card", url)]),
    ]);
    return;
  }

  if (job.toStatus === "gated") {
    const stageName = await stageNameOf(ctx, feature.currentStageId);
    const pendingManual = await hasPendingManual(ctx, feature.id, feature.currentStageId);
    await clearReviewButtons(ctx, client, link, url);
    if (pendingManual) {
      const text = `*${stageName}* needs review.`;
      const posted = await post(text, reviewBlocks(text, feature.id, feature.currentStageId, url));
      if (!posted) return;
      await ctx.db
        .update(slackThreadLinks)
        .set({ reviewMessageTs: posted.ts, updatedAt: new Date() })
        .where(eq(slackThreadLinks.id, link.id));
      return;
    }
    const reason = await waitingReason(ctx, feature.id, feature.currentStageId);
    const text = reason
      ? `*${stageName}* is waiting: ${reason.slice(0, 500)}`
      : `*${stageName}* is waiting. Open the card to see why.`;
    await post(text, [section(text), actions([urlButton("Open card", url)])]);
    return;
  }

  if (job.kind === "stage_moved" && job.toStageId) {
    const fromName = await stageNameOf(ctx, job.fromStageId);
    const toName = await stageNameOf(ctx, job.toStageId);
    const text =
      job.trigger === "gate_auto"
        ? `*${fromName}* passed and moved to *${toName}*.`
        : job.trigger === "manual_back" || job.trigger === "gate_auto_back"
          ? `*${fromName}* was sent back to *${toName}*.`
          : `Moved from *${fromName}* to *${toName}*.`;
    await clearReviewButtons(ctx, client, link, url);
    await post(text, [section(text), actions([urlButton("Open card", url)])]);
  }
}

async function postThread(
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
  link: ThreadLink,
  featureId: string,
  text: string,
  blocks: SlackBlock[],
): Promise<{ ts: string } | null> {
  try {
    return await client.postMessage({
      channel: link.slackChannelId,
      threadTs: link.slackThreadTs,
      text,
      blocks,
    });
  } catch (err) {
    if (err instanceof SlackApiError && err.code && PERMANENT_SLACK_ERRORS.has(err.code)) {
      console.error(`slack.notify dropped (${err.code}) for ${featureId}:`, err.message);
      return null;
    }
    throw err;
  }
}

async function clearReviewButtons(
  ctx: AppContext,
  client: NonNullable<Awaited<ReturnType<typeof slackClientFor>>>,
  link: ThreadLink,
  url: string,
): Promise<void> {
  if (!link.reviewMessageTs) return;
  try {
    await client.updateMessage({
      channel: link.slackChannelId,
      ts: link.reviewMessageTs,
      text: "Review finished.",
      blocks: [section("Review finished."), actions([urlButton("Open card", url)])],
    });
  } catch (err) {
    console.error(`slack review message update for ${link.featureId} failed:`, err);
    return;
  }
  await ctx.db
    .update(slackThreadLinks)
    .set({ reviewMessageTs: null, updatedAt: new Date() })
    .where(eq(slackThreadLinks.id, link.id));
}

async function stageNameOf(ctx: AppContext, stageId: string | null): Promise<string> {
  if (!stageId) return "the backlog";
  const [stage] = await ctx.db.select({ name: stages.name }).from(stages).where(eq(stages.id, stageId)).limit(1);
  return stage?.name ?? "this stage";
}

async function hasPendingManual(
  ctx: AppContext,
  featureId: string,
  stageId: string | null,
): Promise<boolean> {
  if (!stageId) return false;
  const checks = await ctx.db
    .select()
    .from(gateChecks)
    .where(and(eq(gateChecks.featureId, featureId), eq(gateChecks.stageId, stageId)));
  return checks.some((row) => {
    const criterion = row.criterion as { type?: string } | null;
    return criterion?.type === "manual" && row.status === "pending";
  });
}

async function waitingReason(
  ctx: AppContext,
  featureId: string,
  stageId: string | null,
): Promise<string | null> {
  if (!stageId) return null;
  const checks = await ctx.db
    .select()
    .from(gateChecks)
    .where(and(eq(gateChecks.featureId, featureId), eq(gateChecks.stageId, stageId)));
  const open = checks.filter((row) => row.status !== "passed");
  const pick = open.at(-1) ?? checks.at(-1);
  const message = (pick?.detail as { message?: string } | null)?.message?.trim();
  return message || null;
}

/**
 * The agent's last spoken turn, used when a run finished without a
 * stage write-up. That is how a question asked in the transcript still
 * reaches the Slack thread.
 */
async function lastAssistantText(ctx: AppContext, runId: string): Promise<string | null> {
  const rows = await ctx.db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "message")))
    .orderBy(desc(runEvents.seq));
  for (const row of rows) {
    const payload = row.payload as { role?: string; text?: string } | null;
    if (payload?.role !== "assistant") continue;
    const text = payload.text?.trim();
    if (text) return text;
  }
  return null;
}

async function stageWriteUp(ctx: AppContext, runId: string, stageId: string): Promise<string | null> {
  const [stage] = await ctx.db.select({ slug: stages.slug }).from(stages).where(eq(stages.id, stageId)).limit(1);
  if (!stage) return null;
  const expected = stageArtifactPath(stage.slug);
  const [artifact] = await ctx.db
    .select()
    .from(runArtifacts)
    .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.kind, "markdown")))
    .orderBy(desc(runArtifacts.createdAt));
  if (!artifact?.content) return null;
  if (artifact.path !== expected && !artifact.path.endsWith(`/${expected}`)) {
    // Prefer the stage write-up; fall back to any markdown from this run.
    const [writeUp] = await ctx.db
      .select()
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.kind, "markdown"), eq(runArtifacts.path, expected)))
      .limit(1);
    return writeUp?.content ?? artifact.content;
  }
  return artifact.content;
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) } };
}

function actions(elements: SlackBlock[]): SlackBlock {
  return { type: "actions", elements };
}

function urlButton(label: string, url: string): SlackBlock {
  return {
    type: "button",
    action_id: "open_card",
    text: { type: "plain_text", text: label },
    url,
  };
}

export function reviewTargetValue(featureId: string, stageId: string): string {
  return `${featureId}:${stageId}`;
}

export function parseReviewTarget(value: string | undefined): { featureId: string; stageId: string } | null {
  if (!value) return null;
  const [featureId, stageId] = value.split(":");
  if (!featureId || !stageId) return null;
  return { featureId, stageId };
}

export function reviewBlocks(text: string, featureId: string, stageId: string | null, url: string): SlackBlock[] {
  const value = stageId ? reviewTargetValue(featureId, stageId) : featureId;
  return [
    section(text),
    {
      type: "actions",
      block_id: "review",
      elements: [
        {
          type: "button",
          action_id: "approve",
          value,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
        },
        {
          type: "button",
          action_id: "reject",
          value,
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
        },
        urlButton("Open card", url),
      ],
    },
  ];
}

export function projectPickerBlocks(
  pendingId: string,
  options: { id: string; name: string }[],
): SlackBlock[] {
  return [
    section("Which project should this card go to?"),
    {
      type: "actions",
      block_id: pendingId,
      elements: [
        {
          type: "static_select",
          action_id: "pick_project",
          placeholder: { type: "plain_text", text: "Choose a project" },
          options: options.slice(0, 100).map((project) => ({
            text: { type: "plain_text", text: project.name.slice(0, 75) },
            value: project.id,
          })),
        },
      ],
    },
  ];
}

export function rejectModal(input: {
  featureId: string;
  stageId: string;
  channelId: string;
  messageTs: string;
}) {
  return {
    type: "modal",
    callback_id: "reject_card",
    private_metadata: JSON.stringify(input),
    title: { type: "plain_text", text: "Reject card" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "reason",
        optional: true,
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: "reason",
          multiline: true,
        },
      },
    ],
  };
}
