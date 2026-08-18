import { createHmac, timingSafeEqual } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { member, slackConnections, slackPendingMentions, slackThreadLinks, slackUserSettings } from "@bento/db";
import { exchangeOAuthCode, slackAuthorizeUrl } from "@bento/slack";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { canAccessProject } from "../access.js";
import { slackConfigured, slackConnectionRow } from "../slack.js";

type InstallState = { userId: string; organizationId: string | null; expiresAt: number };

export function slackRoutes(ctx: AppContext) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const connection = await slackConnectionRow(ctx, access.organizationId);
    const [settings] = await db(c, ctx)
      .select({ defaultProjectId: slackUserSettings.defaultProjectId })
      .from(slackUserSettings)
      .where(
        and(
          access.organizationId
            ? eq(slackUserSettings.organizationId, access.organizationId)
            : isNull(slackUserSettings.organizationId),
          eq(slackUserSettings.userId, actor(c)),
        ),
      )
      .limit(1);
    return c.json({
      configured: slackConfigured(ctx),
      connected: Boolean(connection),
      canManage: access.canManage,
      teamName: connection?.slackTeamName ?? null,
      defaultProjectId: settings?.defaultProjectId ?? null,
    });
  });

  routes.post("/install", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const secret = stateSecret(ctx);
    if (!slackConfigured(ctx) || !secret || !ctx.env.SLACK_CLIENT_ID) {
      return c.json({ error: "Slack is not configured on this server" }, 503);
    }
    const state = signState(
      {
        userId: actor(c),
        organizationId: access.organizationId,
        expiresAt: Date.now() + 10 * 60_000,
      },
      secret,
    );
    const url = slackAuthorizeUrl({
      clientId: ctx.env.SLACK_CLIENT_ID,
      redirectUri: callbackUrl(ctx),
      state,
    });
    return c.json({ url });
  });

  routes.get("/callback", async (c) => {
    const secret = stateSecret(ctx);
    if (!slackConfigured(ctx) || !secret || !ctx.env.SLACK_CLIENT_ID || !ctx.env.SLACK_CLIENT_SECRET) {
      return outcome(c, "unconfigured");
    }
    const state = verifyState(c.req.query("state"), secret);
    if (!state || state.expiresAt < Date.now() || state.userId !== actor(c)) {
      return outcome(c, "invalid");
    }
    if ((activeOrg(c) ?? null) !== state.organizationId) return outcome(c, "organization");
    const membership = state.organizationId
      ? await membershipFor(ctx, c, state.organizationId)
      : null;
    if (state.organizationId && (!membership || !canManage(membership.role))) return outcome(c, "denied");
    if (!state.organizationId && ctx.env.BENTO_MODE === "multi") return outcome(c, "denied");

    const code = c.req.query("code");
    if (!code) return outcome(c, "invalid");

    let exchanged;
    try {
      exchanged = await exchangeOAuthCode({
        clientId: ctx.env.SLACK_CLIENT_ID,
        clientSecret: ctx.env.SLACK_CLIENT_SECRET,
        code,
        redirectUri: callbackUrl(ctx),
      });
    } catch {
      return outcome(c, "invalid");
    }

    const values = {
      ownerId: actor(c),
      organizationId: state.organizationId,
      slackTeamId: exchanged.teamId,
      slackTeamName: exchanged.teamName,
      botUserId: exchanged.botUserId,
      encryptedBotToken: ctx.secretBox.encrypt(exchanged.botToken),
      installedBy: actor(c),
      updatedAt: new Date(),
    };
    const existing = await slackConnectionRow(ctx, state.organizationId);
    const [taken] = await ctx.db
      .select({ id: slackConnections.id, organizationId: slackConnections.organizationId })
      .from(slackConnections)
      .where(eq(slackConnections.slackTeamId, exchanged.teamId))
      .limit(1);
    if (taken && taken.id !== existing?.id) return outcome(c, "taken");

    try {
      if (existing) {
        await db(c, ctx).update(slackConnections).set(values).where(eq(slackConnections.id, existing.id));
      } else {
        await db(c, ctx).insert(slackConnections).values(values);
      }
    } catch {
      return outcome(c, "taken");
    }
    return outcome(c, "connected");
  });

  routes.delete("/installation", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const orgWhere = access.organizationId
      ? eq(slackConnections.organizationId, access.organizationId)
      : isNull(slackConnections.organizationId);
    const pendingWhere = access.organizationId
      ? eq(slackPendingMentions.organizationId, access.organizationId)
      : isNull(slackPendingMentions.organizationId);
    const linkWhere = access.organizationId
      ? eq(slackThreadLinks.organizationId, access.organizationId)
      : isNull(slackThreadLinks.organizationId);
    await db(c, ctx).delete(slackPendingMentions).where(pendingWhere);
    await db(c, ctx).delete(slackThreadLinks).where(linkWhere);
    await db(c, ctx).delete(slackConnections).where(orgWhere);
    return c.json({ ok: true });
  });

  routes.patch(
    "/settings",
    zValidator("json", z.object({ defaultProjectId: z.string().uuid().nullable() })),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      const { defaultProjectId } = c.req.valid("json");
      if (defaultProjectId && !(await canAccessProject(ctx, c, defaultProjectId))) {
        return c.json({ error: "not found" }, 404);
      }
      const [existing] = await db(c, ctx)
        .select()
        .from(slackUserSettings)
        .where(
          and(
            access.organizationId
              ? eq(slackUserSettings.organizationId, access.organizationId)
              : isNull(slackUserSettings.organizationId),
            eq(slackUserSettings.userId, actor(c)),
          ),
        )
        .limit(1);
      if (existing) {
        await db(c, ctx)
          .update(slackUserSettings)
          .set({ defaultProjectId, updatedAt: new Date() })
          .where(eq(slackUserSettings.id, existing.id));
      } else {
        await db(c, ctx).insert(slackUserSettings).values({
          organizationId: access.organizationId,
          userId: actor(c),
          defaultProjectId,
        });
      }
      return c.json({ defaultProjectId });
    },
  );

  return routes;
}

async function requireAccess(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
): Promise<{ ok: true; organizationId: string | null; canManage: boolean } | { ok: false }> {
  const organizationId = activeOrg(c);
  if (organizationId) {
    const row = await membershipFor(ctx, c, organizationId);
    if (!row) return { ok: false };
    return { ok: true, organizationId, canManage: canManage(row.role) };
  }
  if (ctx.env.BENTO_MODE === "multi") return { ok: false };
  return { ok: true, organizationId: null, canManage: true };
}

async function membershipFor(ctx: AppContext, c: Parameters<typeof actor>[0], organizationId: string) {
  const [row] = await db(c, ctx)
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, actor(c))))
    .limit(1);
  return row ?? null;
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

function callbackUrl(ctx: AppContext): string {
  return `${ctx.env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/slack/callback`;
}

function stateSecret(ctx: AppContext): string | undefined {
  return ctx.env.BENTO_SECRET_KEY ?? ctx.env.BETTER_AUTH_SECRET;
}

function signState(payload: InstallState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyState(value: string | undefined, secret: string): InstallState | null {
  if (!value) return null;
  const [body, provided] = value.split(".");
  if (!body || !provided) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(provided, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<InstallState>;
    return typeof parsed.userId === "string"
      && (parsed.organizationId === null || typeof parsed.organizationId === "string")
      && typeof parsed.expiresAt === "number"
      ? (parsed as InstallState)
      : null;
  } catch {
    return null;
  }
}

function outcome(c: Parameters<typeof actor>[0], result: string) {
  return c.redirect(`/settings?tab=slack&slack=${result}`);
}
