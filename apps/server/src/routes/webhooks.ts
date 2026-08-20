import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseRepoUrl, verifyWebhookSignature, webhookTarget } from "@bento/github";
import { parseIssueWebhook, verifyLinearWebhookSignature } from "@bento/linear";
import { verifySlackSignature } from "@bento/slack";
import { features, githubInstallations, projects, slackConnections, slackPendingMentions } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { linearConnectionRow } from "../linear.js";
import { slackClientFor, slackConnectionByTeam } from "../slack.js";
import { interactiveChannelId, interactiveTeamId, isUuid, parseReviewTarget, projectPickFromInteractive, rejectModal } from "../orchestrator/slack-notify.js";
import type { SlackInboundJob } from "../orchestrator/slack-sync.js";

/**
 * GitHub webhook receiver. Any event that touches a PR we track queues a
 * gate re-evaluation for the matching feature, which is what makes
 * "advance when review comments are resolved" feel immediate.
 * Self-hosters without a public URL rely on the gate.sweep cron instead.
 */
export function webhookRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * Linear webhook receiver. The organization id rides in the path
     * because Linear's payload carries no Bento tenant and each org
     * verifies against its own secret. Verified events are queued and
     * answered immediately; the worker does the actual import/update.
     */
    .post("/linear/:orgId", async (c) => {
      const orgParam = c.req.param("orgId");
      const organizationId = orgParam === "local" ? null : orgParam;
      const connection = await linearConnectionRow(ctx, organizationId);
      if (!connection?.encryptedWebhookSecret) return c.json({ error: "webhooks not configured" }, 503);

      let secret: string;
      try {
        secret = ctx.secretBox.decrypt(connection.encryptedWebhookSecret);
      } catch {
        return c.json({ error: "webhooks not configured" }, 503);
      }
      const raw = await c.req.text();
      if (!verifyLinearWebhookSignature(secret, raw, c.req.header("linear-signature"))) {
        return c.json({ error: "invalid signature" }, 401);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid payload" }, 400);
      }
      const event = parseIssueWebhook(payload);
      if (!event) return c.json({ ok: true, matched: 0 });

      await ctx.boss.send("linear.inbound", {
        organizationId,
        action: event.action,
        issue: event.data,
      });
      return c.json({ ok: true, matched: 1 });
    })
    .post("/github", async (c) => {
    const secret = ctx.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhooks not configured" }, 503);

    const raw = await c.req.text();
    if (!verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event") ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }

    if (event === "installation") {
      const installationEvent = payload as { action?: string; installation?: { id?: number } };
      if (
        (installationEvent.action === "deleted" || installationEvent.action === "suspend")
        && installationEvent.installation?.id !== undefined
      ) {
        await ctx.db
          .delete(githubInstallations)
          .where(eq(githubInstallations.installationId, String(installationEvent.installation.id)));
      }
      return c.json({ ok: true, matched: 0 });
    }

    const target = webhookTarget(event, payload);
    if (!target) return c.json({ ok: true, matched: 0 });

    const projectRows = await db(c, ctx).select().from(projects);
    const matching = projectRows.filter((p) => {
      if (!p.repoUrl) return false;
      const parsed = parseRepoUrl(p.repoUrl);
      return parsed?.owner === target.owner && parsed.repo === target.repo;
    });

    let matched = 0;
    for (const project of matching) {
      const featureRows = await db(c, ctx).select().from(features).where(eq(features.projectId, project.id));
      for (const feature of featureRows) {
        if (feature.prNumber !== target.prNumber) continue;
        await ctx.boss.send("gate.evaluate", { featureId: feature.id });
        matched += 1;
      }
    }
    return c.json({ ok: true, matched });
  })
    /**
     * Slack Events API. Signature checked against the app signing
     * secret; the workspace is resolved later from team_id. Answered
     * immediately so Slack does not retry while the worker creates
     * the card.
     */
    .post("/slack/events", async (c) => {
      const raw = await c.req.text();
      const signed = slackSignatureStatus(ctx, raw, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature"));
      if (signed !== "ok") {
        return c.json({ error: signed === "missing" ? "webhooks not configured" : "invalid signature" }, signed === "missing" ? 503 : 401);
      }
      let payload: SlackEventPayload;
      try {
        payload = JSON.parse(raw) as SlackEventPayload;
      } catch {
        return c.json({ error: "invalid payload" }, 400);
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        return c.json({ challenge: payload.challenge });
      }
      if (payload.type === "event_callback" && payload.team_id && (
        payload.event?.type === "app_uninstalled" || payload.event?.type === "tokens_revoked"
      )) {
        await ctx.db.delete(slackPendingMentions).where(eq(slackPendingMentions.slackTeamId, payload.team_id));
        await ctx.db.delete(slackConnections).where(eq(slackConnections.slackTeamId, payload.team_id));
        return c.json({ ok: true });
      }
      if (payload.type === "event_callback" && payload.event?.type === "app_mention") {
        const event = payload.event;
        if (event.user && event.channel && event.ts && payload.team_id) {
          await ctx.boss.send("slack.inbound", {
            kind: "mention",
            teamId: payload.team_id,
            channelId: event.channel,
            userId: event.user,
            text: event.text ?? "",
            ts: event.ts,
            threadTs: event.thread_ts ?? event.ts,
          } satisfies SlackInboundJob);
        }
      }
      return c.json({ ok: true });
    })
    /**
     * Slack interactivity: project picker, Approve, Reject. Reject
     * opens a modal here because Slack's trigger_id expires in three
     * seconds, too short to wait on the queue.
     */
    .post("/slack/interactive", async (c) => {
      const raw = await c.req.text();
      const signed = slackSignatureStatus(ctx, raw, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature"));
      if (signed !== "ok") {
        return c.json({ error: signed === "missing" ? "webhooks not configured" : "invalid signature" }, signed === "missing" ? 503 : 401);
      }
      const payload = parseInteractivePayload(raw);
      if (!payload) return c.json({ ok: true });

      if (payload.type === "block_actions") {
        const action = payload.actions?.[0];
        const userId = payload.user?.id;
        const pick = projectPickFromInteractive(payload);
        if (pick) {
          const resolved = await resolvePickLocation(ctx, pick);
          if (resolved) {
            await ctx.boss.send("slack.inbound", {
              kind: "pick_project",
              teamId: resolved.teamId,
              channelId: resolved.channelId,
              userId: pick.userId,
              pendingId: pick.pendingId,
              projectId: pick.projectId,
            } satisfies SlackInboundJob);
            if (payload.response_url) {
              void replaceInteractive(payload.response_url, "Creating that card...");
            }
          } else {
            console.warn("slack interactive pick had no team or pending row", {
              pendingId: pick.pendingId,
              hasTeam: Boolean(pick.teamId),
            });
          }
        }
        const teamId = interactiveTeamId(payload);
        const channelId = interactiveChannelId(payload);
        if (action?.action_id === "reject" && action.value && payload.trigger_id && payload.message?.ts && teamId && channelId && userId) {
          const target = parseReviewTarget(action.value);
          const connection = await slackConnectionByTeam(ctx, teamId);
          const client = connection ? await slackClientFor(ctx, connection) : null;
          if (client && target) {
            await client.openView({
              triggerId: payload.trigger_id,
              view: rejectModal({
                featureId: target.featureId,
                stageId: target.stageId,
                channelId,
                messageTs: payload.message.ts,
              }),
            });
          }
          return c.json({ ok: true });
        }
        if (action?.action_id === "approve" && action.value && payload.message?.ts && teamId && channelId && userId) {
          const target = parseReviewTarget(action.value);
          if (target) {
            await ctx.boss.send("slack.inbound", {
              kind: "approve",
              teamId,
              channelId,
              userId,
              featureId: target.featureId,
              stageId: target.stageId,
              messageTs: payload.message.ts,
            } satisfies SlackInboundJob);
          }
        }
        if (!pick && action?.action_id && action.action_id !== "approve" && action.action_id !== "reject" && action.action_id !== "open_card") {
          console.warn("slack interactive ignored", {
            actionId: action.action_id,
            hasTeam: Boolean(teamId),
            hasChannel: Boolean(channelId),
            hasValue: Boolean(action.value ?? action.selected_option?.value),
          });
        }
        return c.json({ ok: true });
      }

      if (payload.type === "view_submission" && payload.view?.callback_id === "reject_card") {
        let meta: { featureId?: string; stageId?: string; channelId?: string; messageTs?: string };
        try {
          meta = JSON.parse(payload.view.private_metadata ?? "{}") as {
            featureId?: string;
            stageId?: string;
            channelId?: string;
            messageTs?: string;
          };
        } catch {
          return c.json({ ok: true });
        }
        const reason = payload.view.state?.values?.reason?.reason?.value ?? "";
        const teamId = interactiveTeamId(payload);
        if (
          payload.user?.id
          && teamId
          && meta.featureId
          && meta.stageId
          && meta.channelId
          && meta.messageTs
        ) {
          await ctx.boss.send("slack.inbound", {
            kind: "reject",
            teamId,
            channelId: meta.channelId,
            userId: payload.user.id,
            featureId: meta.featureId,
            stageId: meta.stageId,
            messageTs: meta.messageTs,
            reason,
          } satisfies SlackInboundJob);
        }
      }
      return c.json({ ok: true });
    });
}

function slackSignatureStatus(
  ctx: AppContext,
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
): "ok" | "missing" | "invalid" {
  const secret = ctx.env.SLACK_SIGNING_SECRET;
  if (!secret) return "missing";
  return verifySlackSignature(secret, body, timestamp, signature) ? "ok" : "invalid";
}

interface SlackEventPayload {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
  };
}

interface SlackInteractivePayload {
  type?: string;
  trigger_id?: string;
  response_url?: string;
  user?: { id?: string; team_id?: string };
  team?: { id?: string };
  channel?: { id?: string } | string;
  message?: { ts?: string };
  container?: { block_id?: string; channel_id?: string };
  actions?: {
    action_id?: string;
    block_id?: string;
    value?: string;
    selected_option?: { value?: string };
  }[];
  state?: {
    values?: Record<string, Record<string, { selected_option?: { value?: string } } | undefined> | undefined>;
  };
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: { reason?: { reason?: { value?: string } } } };
  };
}

function parseInteractivePayload(raw: string): SlackInteractivePayload | null {
  const params = new URLSearchParams(raw);
  const encoded = params.get("payload") ?? raw;
  try {
    return JSON.parse(encoded) as SlackInteractivePayload;
  } catch {
    return null;
  }
}

async function resolvePickLocation(
  ctx: AppContext,
  pick: { teamId: string; channelId: string; pendingId: string },
): Promise<{ teamId: string; channelId: string } | null> {
  if (pick.teamId) return { teamId: pick.teamId, channelId: pick.channelId };
  if (!isUuid(pick.pendingId)) return null;
  const [pending] = await ctx.db
    .select({
      slackTeamId: slackPendingMentions.slackTeamId,
      slackChannelId: slackPendingMentions.slackChannelId,
    })
    .from(slackPendingMentions)
    .where(eq(slackPendingMentions.id, pick.pendingId))
    .limit(1);
  if (!pending) return null;
  return {
    teamId: pending.slackTeamId,
    channelId: pick.channelId || pending.slackChannelId,
  };
}

async function replaceInteractive(responseUrl: string, text: string): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ replace_original: true, text }),
    });
    if (!res.ok) {
      console.warn(`slack response_url failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("slack response_url failed:", err);
  }
}
