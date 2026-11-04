import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { linearConnections, linearIssueLinks, linearTeamMappings, member, projects } from "@bento/db";
import { LinearClient } from "@bento/linear";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { deferAfterCommit, tenantDb as db } from "../middleware/tenant.js";
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
    // A source names a team and project in this workspace; another
    // workspace connected later must not inherit it.
    await db(c, ctx)
      .update(projects)
      .set({
        linearImportTeamId: null,
        linearImportTeamKey: null,
        linearImportTeamName: null,
        linearImportProjectId: null,
        linearImportProjectName: null,
      })
      .where(orgFilter(projects.organizationId, access.organizationId));
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

  /**
   * The Linear projects of one team, for the picker that says where
   * issues filed from Bento land.
   */
  routes.get("/projects", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const teamId = c.req.query("teamId");
    if (!teamId) return c.json({ error: "teamId is required" }, 400);
    const connection = await linearConnectionFor(ctx, access.organizationId);
    if (!connection) return c.json({ error: "connect Linear first" }, 409);
    try {
      return c.json(await connection.client.teamProjects(teamId));
    } catch {
      return c.json({ error: "Linear did not answer. Check the API key and try again." }, 502);
    }
  });

  /**
   * Workspace-level settings: only the inbound default is left here.
   * Whether a card files an issue, and where, is set per project.
   */
  routes.patch(
    "/settings",
    zValidator(
      "json",
      z.object({
        defaultProjectId: z.string().uuid().nullable().optional(),
      }),
    ),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
      const body = c.req.valid("json");
      const connection = await linearConnectionRow(ctx, access.organizationId);
      if (!connection) return c.json({ error: "connect Linear first" }, 409);

      const values: Partial<typeof linearConnections.$inferInsert> = { updatedAt: new Date() };

      if (body.defaultProjectId !== undefined) {
        if (body.defaultProjectId && !(await canAccessProject(ctx, c, body.defaultProjectId))) {
          return c.json({ error: "not found" }, 404);
        }
        values.defaultProjectId = body.defaultProjectId;
      }

      const [updated] = await db(c, ctx)
        .update(linearConnections)
        .set(values)
        .where(orgFilter(linearConnections.organizationId, access.organizationId))
        .returning();
      if (!updated) return c.json({ error: "connect Linear first" }, 409);
      return c.json({ defaultProjectId: updated.defaultProjectId });
    },
  );

  /**
   * One project's outbound settings: whether its cards file issues, the
   * team they are filed in, and the Linear project they join. Every
   * field is optional and only what was sent is written, so the panel
   * can flip one toggle without restating the rest.
   */
  routes.patch(
    "/projects/:projectId/settings",
    zValidator(
      "json",
      z.object({
        createIssues: z.boolean().optional(),
        teamId: z.string().min(1).nullable().optional(),
        linearProjectId: z.string().min(1).nullable().optional(),
        importTeamId: z.string().min(1).nullable().optional(),
        importLinearProjectId: z.string().min(1).nullable().optional(),
      }),
    ),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
      const projectId = c.req.param("projectId");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const body = c.req.valid("json");
      const [project] = await db(c, ctx)
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project) return c.json({ error: "not found" }, 404);

      const values: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };

      if (body.createIssues !== undefined) values.linearCreateIssues = body.createIssues;

      // The outbound team and project, then the inbound ones: the same
      // rules on two sets of columns.
      const outbound = await applyTeamAndProject(ctx, access.organizationId, {
        teamId: body.teamId,
        linearProjectId: body.linearProjectId,
        storedTeamId: project.linearTeamId,
      });
      if ("error" in outbound) return c.json({ error: outbound.error }, outbound.status);
      if (outbound.team !== undefined) {
        values.linearTeamId = outbound.team?.id ?? null;
        values.linearTeamKey = outbound.team?.key ?? null;
        values.linearTeamName = outbound.team?.name ?? null;
      }
      if (outbound.project !== undefined) {
        values.linearProjectId = outbound.project?.id ?? null;
        values.linearProjectName = outbound.project?.name ?? null;
      }

      const inbound = await applyTeamAndProject(ctx, access.organizationId, {
        teamId: body.importTeamId,
        linearProjectId: body.importLinearProjectId,
        storedTeamId: project.linearImportTeamId,
      });
      if ("error" in inbound) return c.json({ error: inbound.error }, inbound.status);
      if (inbound.team !== undefined) {
        values.linearImportTeamId = inbound.team?.id ?? null;
        values.linearImportTeamKey = inbound.team?.key ?? null;
        values.linearImportTeamName = inbound.team?.name ?? null;
      }
      if (inbound.project !== undefined) {
        values.linearImportProjectId = inbound.project?.id ?? null;
        values.linearImportProjectName = inbound.project?.name ?? null;
      }

      const [updated] = await db(c, ctx)
        .update(projects)
        .set(values)
        .where(eq(projects.id, projectId))
        .returning();
      if (!updated) return c.json({ error: "not found" }, 404);

      // A source just named: bring in what is already open there now
      // rather than at the next sweep. After the commit, so the job
      // reads the source this request wrote.
      const sourceChanged =
        updated.linearImportTeamId !== project.linearImportTeamId ||
        updated.linearImportProjectId !== project.linearImportProjectId;
      if (sourceChanged && updated.linearImportProjectId) {
        const organizationId = access.organizationId;
        deferAfterCommit(c, async () => {
          await ctx.boss.send("linear.backlog-sync", { organizationId });
        });
      }

      return c.json({
        linearCreateIssues: updated.linearCreateIssues,
        linearTeamId: updated.linearTeamId,
        linearTeamKey: updated.linearTeamKey,
        linearTeamName: updated.linearTeamName,
        linearProjectId: updated.linearProjectId,
        linearProjectName: updated.linearProjectName,
        linearImportTeamId: updated.linearImportTeamId,
        linearImportTeamKey: updated.linearImportTeamKey,
        linearImportTeamName: updated.linearImportTeamName,
        linearImportProjectId: updated.linearImportProjectId,
        linearImportProjectName: updated.linearImportProjectName,
      });
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

interface TeamAndProjectChange {
  /** Undefined leaves the stored value alone; null clears it. */
  team?: { id: string; key: string; name: string } | null;
  project?: { id: string; name: string } | null;
}

/**
 * Checks a team and Linear project pair against Linear and says what to
 * store. Shared by the outbound and inbound settings, which follow the
 * same rules: a Linear project belongs to a team, so clearing or
 * replacing the team clears the project, and a project is only taken
 * from the team it will be stored with.
 */
async function applyTeamAndProject(
  ctx: AppContext,
  organizationId: string | null,
  input: {
    teamId: string | null | undefined;
    linearProjectId: string | null | undefined;
    storedTeamId: string | null;
  },
): Promise<TeamAndProjectChange | { error: string; status: 400 | 404 | 409 | 502 }> {
  const result: TeamAndProjectChange = {};
  // The team a Linear project is checked against: the one this request
  // sets, or the stored one when it leaves the team alone.
  let teamId = input.storedTeamId;

  if (input.teamId !== undefined) {
    if (input.teamId === null) {
      result.team = null;
      result.project = null;
      teamId = null;
    } else {
      const connection = await linearConnectionFor(ctx, organizationId);
      if (!connection) return { error: "connect Linear first", status: 409 };
      let team;
      try {
        team = (await connection.client.teams()).find((t) => t.id === input.teamId);
      } catch {
        return { error: "Linear did not answer. Check the API key and try again.", status: 502 };
      }
      if (!team) return { error: "not found", status: 404 };
      result.team = { id: team.id, key: team.key, name: team.name };
      // The stored project belonged to the team being replaced.
      if (team.id !== input.storedTeamId) result.project = null;
      teamId = team.id;
    }
  }

  if (input.linearProjectId !== undefined) {
    if (input.linearProjectId === null) {
      result.project = null;
    } else {
      if (!teamId) return { error: "pick a team first", status: 400 };
      const connection = await linearConnectionFor(ctx, organizationId);
      if (!connection) return { error: "connect Linear first", status: 409 };
      let linearProject;
      try {
        linearProject = (await connection.client.teamProjects(teamId)).find(
          (p) => p.id === input.linearProjectId,
        );
      } catch {
        return { error: "Linear did not answer. Check the API key and try again.", status: 502 };
      }
      if (!linearProject) return { error: "not found", status: 404 };
      result.project = { id: linearProject.id, name: linearProject.name };
    }
  }
  return result;
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
