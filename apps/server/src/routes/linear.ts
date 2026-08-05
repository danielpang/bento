import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { linearConnections, linearIssueLinks, linearTeamMappings, member } from "@bento/db";
import { LinearClient } from "@bento/linear";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { canAccessProject } from "../access.js";
import { maskSecret } from "../secrets.js";
import { importLinearIssue, linearConnectionFor, linearConnectionRow } from "../linear.js";

export function linearRoutes(ctx: AppContext) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const connection = await linearConnectionRow(ctx, access.organizationId);
    const mappings = connection
      ? await db(c, ctx)
          .select()
          .from(linearTeamMappings)
          .where(orgFilter(linearTeamMappings.organizationId, access.organizationId))
      : [];
    return c.json({
      connected: Boolean(connection),
      hint: connection?.hint ?? null,
      webhook: Boolean(connection?.webhookId),
      defaultProjectId: connection?.defaultProjectId ?? null,
      canManage: access.canManage,
      mappings: mappings.map((m) => ({
        id: m.id,
        linearTeamId: m.linearTeamId,
        linearTeamKey: m.linearTeamKey,
        linearTeamName: m.linearTeamName,
        projectId: m.projectId,
      })),
    });
  });

  routes.post("/connect", zValidator("json", z.object({ apiKey: z.string().min(8) })), async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const { apiKey } = c.req.valid("json");

    const client = new LinearClient(apiKey);
    try {
      await client.viewer();
    } catch {
      return c.json({ error: "Linear rejected this API key" }, 400);
    }

    const values = {
      ownerId: actor(c),
      organizationId: access.organizationId,
      encryptedApiKey: ctx.secretBox.encrypt(apiKey),
      hint: maskSecret(apiKey),
      updatedAt: new Date(),
    };
    const existing = await linearConnectionRow(ctx, access.organizationId);
    if (existing) {
      await db(c, ctx).update(linearConnections).set(values).where(eq(linearConnections.id, existing.id));
    } else {
      await db(c, ctx).insert(linearConnections).values(values);
    }

    // Webhook provisioning is best effort: it needs a publicly
    // reachable server and a key allowed to create webhooks. Without
    // either, the cron sweep and Sync now cover inbound changes.
    let webhook = false;
    const base = webhookBaseUrl(ctx);
    if (base) {
      try {
        const secret = randomBytes(32).toString("hex");
        const url = `${base}/api/webhooks/linear/${access.organizationId ?? "local"}`;
        const webhookId = await client.webhookCreate({ url, secret });
        await db(c, ctx)
          .update(linearConnections)
          .set({ webhookId, encryptedWebhookSecret: ctx.secretBox.encrypt(secret), updatedAt: new Date() })
          .where(orgFilter(linearConnections.organizationId, access.organizationId));
        webhook = true;
      } catch {
        webhook = false;
      }
    }
    return c.json({ connected: true, webhook });
  });

  routes.delete("/connect", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const connection = await linearConnectionFor(ctx, access.organizationId);
    if (connection?.connection.webhookId) {
      try {
        await connection.client.webhookDelete(connection.connection.webhookId);
      } catch {
        // The key may already be revoked; the connection goes anyway.
      }
    }
    await db(c, ctx)
      .delete(linearTeamMappings)
      .where(orgFilter(linearTeamMappings.organizationId, access.organizationId));
    await db(c, ctx)
      .delete(linearIssueLinks)
      .where(orgFilter(linearIssueLinks.organizationId, access.organizationId));
    await db(c, ctx)
      .delete(linearConnections)
      .where(orgFilter(linearConnections.organizationId, access.organizationId));
    return c.json({ ok: true });
  });

  routes.get("/teams", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const connection = await linearConnectionFor(ctx, access.organizationId);
    if (!connection) return c.json({ error: "connect Linear first" }, 409);
    try {
      return c.json(await connection.client.teams());
    } catch {
      return c.json({ error: "Linear did not answer. Check the API key and try again." }, 502);
    }
  });

  routes.get("/mappings", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const rows = await db(c, ctx)
      .select()
      .from(linearTeamMappings)
      .where(orgFilter(linearTeamMappings.organizationId, access.organizationId));
    return c.json(rows);
  });

  routes.post(
    "/mappings",
    zValidator("json", z.object({ linearTeamId: z.string().min(1), projectId: z.string().uuid() })),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
      const { linearTeamId, projectId } = c.req.valid("json");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const connection = await linearConnectionFor(ctx, access.organizationId);
      if (!connection) return c.json({ error: "connect Linear first" }, 409);
      const team = (await connection.client.teams()).find((t) => t.id === linearTeamId);
      if (!team) return c.json({ error: "not found" }, 404);
      // Read then write rather than ON CONFLICT: in local mode the
      // organization is null, and nulls never collide in the composite
      // unique index, so the conflict clause would miss the partial
      // local index and a remap would surface as a constraint error.
      const [existing] = await db(c, ctx)
        .select({ id: linearTeamMappings.id })
        .from(linearTeamMappings)
        .where(
          and(
            orgFilter(linearTeamMappings.organizationId, access.organizationId),
            eq(linearTeamMappings.linearTeamId, team.id),
          ),
        )
        .limit(1);
      const values = {
        linearTeamKey: team.key,
        linearTeamName: team.name,
        projectId,
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await db(c, ctx)
            .update(linearTeamMappings)
            .set(values)
            .where(eq(linearTeamMappings.id, existing.id))
            .returning()
        : await db(c, ctx)
            .insert(linearTeamMappings)
            .values({ ...values, organizationId: access.organizationId, linearTeamId: team.id })
            .returning();
      return c.json(row, 201);
    },
  );

  routes.delete("/mappings/:id", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const deleted = await db(c, ctx)
      .delete(linearTeamMappings)
      .where(
        and(
          eq(linearTeamMappings.id, c.req.param("id")),
          orgFilter(linearTeamMappings.organizationId, access.organizationId),
        ),
      )
      .returning({ id: linearTeamMappings.id });
    if (!deleted.length) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  routes.patch(
    "/settings",
    zValidator("json", z.object({ defaultProjectId: z.string().uuid().nullable() })),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
      const { defaultProjectId } = c.req.valid("json");
      if (defaultProjectId && !(await canAccessProject(ctx, c, defaultProjectId))) {
        return c.json({ error: "not found" }, 404);
      }
      const updated = await db(c, ctx)
        .update(linearConnections)
        .set({ defaultProjectId, updatedAt: new Date() })
        .where(orgFilter(linearConnections.organizationId, access.organizationId))
        .returning({ id: linearConnections.id });
      if (!updated.length) return c.json({ error: "connect Linear first" }, 409);
      return c.json({ defaultProjectId });
    },
  );

  routes.get("/issues", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const teamId = c.req.query("teamId");
    if (!teamId) return c.json({ error: "teamId is required" }, 400);
    const connection = await linearConnectionFor(ctx, access.organizationId);
    if (!connection) return c.json({ error: "connect Linear first" }, 409);
    let page;
    try {
      page = await connection.client.issues({
        teamId,
        stateTypes: ["backlog", "unstarted"],
        after: c.req.query("after") || undefined,
      });
    } catch {
      return c.json({ error: "Linear did not answer. Check the API key and try again." }, 502);
    }
    const ids = page.issues.map((issue) => issue.id);
    const imported = ids.length
      ? await db(c, ctx)
          .select({ linearIssueId: linearIssueLinks.linearIssueId })
          .from(linearIssueLinks)
          .where(
            and(
              orgFilter(linearIssueLinks.organizationId, access.organizationId),
              inArray(linearIssueLinks.linearIssueId, ids),
            ),
          )
      : [];
    const importedIds = new Set(imported.map((row) => row.linearIssueId));
    return c.json({
      issues: page.issues.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        stateName: issue.state.name,
        imported: importedIds.has(issue.id),
      })),
      endCursor: page.endCursor,
      hasNextPage: page.hasNextPage,
    });
  });

  routes.post(
    "/import",
    zValidator(
      "json",
      z.object({ issueIds: z.array(z.string().min(1)).min(1).max(50), projectId: z.string().uuid() }),
    ),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      const { issueIds, projectId } = c.req.valid("json");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const connection = await linearConnectionFor(ctx, access.organizationId);
      if (!connection) return c.json({ error: "connect Linear first" }, 409);
      let importedCount = 0;
      for (const issueId of issueIds) {
        const issue = await connection.client.issue(issueId);
        if (!issue) continue;
        const featureId = await importLinearIssue(ctx, {
          organizationId: access.organizationId,
          projectId,
          issue,
        });
        if (featureId) importedCount += 1;
      }
      return c.json({ imported: importedCount });
    },
  );

  routes.post("/sync", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const connection = await linearConnectionRow(ctx, access.organizationId);
    if (!connection) return c.json({ error: "connect Linear first" }, 409);
    await ctx.boss.send("linear.backlog-sync", { organizationId: access.organizationId });
    return c.json({ ok: true });
  });

  return routes;
}

function orgFilter(column: any, organizationId: string | null) {
  return organizationId ? eq(column, organizationId) : isNull(column);
}

/**
 * Resolves the caller's tenant. Multi mode requires a live membership
 * (re-read per request, so removal takes effect immediately); local
 * mode has one trusted user and no organizations.
 */
async function requireAccess(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
): Promise<{ ok: true; organizationId: string | null; canManage: boolean } | { ok: false }> {
  const organizationId = activeOrg(c);
  if (organizationId) {
    const [row] = await db(c, ctx)
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, actor(c))))
      .limit(1);
    if (!row) return { ok: false };
    return { ok: true, organizationId, canManage: row.role === "owner" || row.role === "admin" };
  }
  if (ctx.env.BENTO_MODE === "multi") return { ok: false };
  return { ok: true, organizationId: null, canManage: true };
}

/** A base URL Linear can actually reach, or null to skip provisioning. */
function webhookBaseUrl(ctx: AppContext): string | null {
  const base = ctx.env.BETTER_AUTH_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return base.replace(/\/$/, "");
  } catch {
    return null;
  }
}
