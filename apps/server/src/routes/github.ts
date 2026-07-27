import { createHmac, timingSafeEqual } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { account, githubInstallations, member, organizationPolicies } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { githubConnectionFor } from "../github.js";
import { readSettings, shouldIncludeStageNotes, writeSettings } from "../settings.js";

type InstallState = { userId: string; organizationId: string; expiresAt: number };

export function githubRoutes(ctx: AppContext) {
  const routes = new Hono();

  /**
   * Whether GitHub is reachable, and how.
   *
   * Answered in every mode rather than 404ing without an organization:
   * clients could not tell "no GitHub App here" from "the check itself
   * failed", and collapsed the two into offering a local path field on
   * a hosted install. `canPublish` is the question the pull request
   * controls actually ask, and a saved token answers it just as well
   * as an App installation does.
   */
  routes.get("/status", async (c) => {
    const membership = await currentMembership(ctx, c);
    const organizationId = membership?.organizationId ?? null;
    const [installation] = organizationId
      ? await db(c, ctx)
          .select({
            accountLogin: githubInstallations.accountLogin,
            accountType: githubInstallations.accountType,
          })
          .from(githubInstallations)
          .where(eq(githubInstallations.organizationId, organizationId))
          .limit(1)
      : [];
    return c.json({
      configured: Boolean(ctx.githubApp && ctx.env.GITHUB_APP_SLUG),
      connected: Boolean(installation),
      canPublish: Boolean(await githubConnectionFor(ctx, organizationId)),
      canManage: membership ? canManage(membership.role) : false,
      installation: installation ?? null,
    });
  });

  /**
   * Settings about what Bento puts into a pull request, as opposed to
   * how it authenticates. One route in both modes, because the question
   * is the same one; where the answer is kept differs.
   */
  routes.get("/settings", async (c) => {
    const membership = await currentMembership(ctx, c);
    return c.json({
      includeStageNotesInPr: await shouldIncludeStageNotes(ctx, membership?.organizationId ?? null),
      // A shared server settles this per organization, so a member who
      // cannot manage it should see it stated rather than editable.
      canManage: membership ? canManage(membership.role) : ctx.env.BENTO_MODE !== "multi",
    });
  });

  routes.patch(
    "/settings",
    zValidator("json", z.object({ includeStageNotesInPr: z.boolean() })),
    async (c) => {
      const { includeStageNotesInPr } = c.req.valid("json");
      const membership = await currentMembership(ctx, c);
      if (membership) {
        if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
        await db(c, ctx)
          .insert(organizationPolicies)
          .values({ organizationId: membership.organizationId, includeStageNotesInPr })
          .onConflictDoUpdate({
            target: organizationPolicies.organizationId,
            set: { includeStageNotesInPr, updatedAt: new Date() },
          });
        return c.json({ includeStageNotesInPr });
      }
      if (ctx.env.BENTO_MODE === "multi") return c.json({ error: "not found" }, 404);
      await writeSettings(ctx, { ...(await readSettings(ctx)), includeStageNotesInPr });
      return c.json({ includeStageNotesInPr });
    },
  );

  routes.post("/install", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
    if (!ctx.githubApp || !ctx.env.GITHUB_APP_SLUG || !ctx.env.BENTO_SECRET_KEY) {
      return c.json({ error: "GitHub App installation is not configured" }, 503);
    }
    const state = signState(
      {
        userId: actor(c),
        organizationId: membership.organizationId,
        expiresAt: Date.now() + 10 * 60_000,
      },
      ctx.env.BENTO_SECRET_KEY,
    );
    const url = new URL(`https://github.com/apps/${ctx.env.GITHUB_APP_SLUG}/installations/new`);
    url.searchParams.set("state", state);
    return c.json({ url: url.toString() });
  });

  routes.get("/callback", async (c) => {
    if (!ctx.githubApp || !ctx.env.BENTO_SECRET_KEY) return c.json({ error: "GitHub App is not configured" }, 503);
    const state = verifyState(c.req.query("state"), ctx.env.BENTO_SECRET_KEY);
    const installationId = c.req.query("installation_id");
    if (!state || !installationId || state.expiresAt < Date.now() || state.userId !== actor(c)) {
      return c.json({ error: "invalid or expired GitHub installation request" }, 400);
    }
    if (activeOrg(c) !== state.organizationId) {
      return c.json({ error: "switch back to the organization that started this installation" }, 409);
    }
    const membership = await membershipFor(ctx, c, state.organizationId);
    if (!membership || !canManage(membership.role)) return c.json({ error: "not found" }, 404);
    if (!(await userCanAccessInstallation(ctx, actor(c), installationId))) {
      return c.json({ error: "sign in with GitHub using an account that can manage this installation" }, 403);
    }

    const installation = await ctx.githubApp.installation(installationId);
    await db(c, ctx)
      .insert(githubInstallations)
      .values({
        organizationId: state.organizationId,
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        installedBy: actor(c),
      })
      .onConflictDoUpdate({
        target: githubInstallations.organizationId,
        set: {
          installationId: installation.id,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          installedBy: actor(c),
          updatedAt: new Date(),
        },
      });
    return c.redirect("/?github=connected");
  });

  routes.get("/repositories", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    const [installation] = await db(c, ctx)
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(eq(githubInstallations.organizationId, membership.organizationId))
      .limit(1);
    if (!installation || !ctx.githubApp) return c.json({ error: "connect the GitHub App first" }, 409);
    return c.json(await ctx.githubApp.forInstallation(installation.installationId).listRepositories());
  });

  routes.delete("/installation", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
    await db(c, ctx)
      .delete(githubInstallations)
      .where(eq(githubInstallations.organizationId, membership.organizationId));
    return c.json({ ok: true });
  });

  return routes;
}

async function currentMembership(ctx: AppContext, c: Parameters<typeof actor>[0]) {
  const organizationId = activeOrg(c);
  return organizationId ? membershipFor(ctx, c, organizationId) : null;
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
      && typeof parsed.organizationId === "string"
      && typeof parsed.expiresAt === "number"
      ? parsed as InstallState
      : null;
  } catch {
    return null;
  }
}

async function userCanAccessInstallation(ctx: AppContext, userId: string, installationId: string): Promise<boolean> {
  const [githubAccount] = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!githubAccount?.accessToken) return false;

  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubAccount.accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return false;
    const body = await response.json() as { installations?: { id: number }[] };
    const rows = body.installations ?? [];
    if (rows.some((row) => String(row.id) === installationId)) return true;
    if (rows.length < 100) return false;
  }
  return false;
}
