import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { mcpConnections, member, projects, user } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { getBetaTester } from "../feature-flags.js";
import { mintConnectionToken } from "../mcp/connections.js";

/**
 * Management of inbound MCP connections: the tokens outside agents
 * present to Bento's own MCP server at /api/mcp-server.
 *
 * A connection acts as its creator, so any member may authorize one,
 * scoped to the whole organization or to a selection of projects they
 * can see. Members manage their own; owners and admins additionally see
 * and revoke everyone's, the personal-server governance model. The raw
 * token is returned once from the create and never again.
 *
 * Beta: these routes answer 404 to anyone off the beta-testers flag,
 * the getBetaTester convention.
 */

const createConnection = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(["organization", "projects"]),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
});

export function mcpConnectionRoutes(ctx: AppContext) {
  const routes = new Hono();
  const notFound = (c: Context) => c.json({ error: "not found" }, 404);

  routes.get("/", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const me = actor(c);
    const rows = await db(c, ctx)
      .select({ connection: mcpConnections, ownerName: user.name })
      .from(mcpConnections)
      .leftJoin(user, eq(user.id, mcpConnections.ownerId))
      .where(orgFilter(access.organizationId))
      .orderBy(desc(mcpConnections.createdAt));
    // A member sees their own connections; admins see everyone's,
    // because a standing credential into the team's board is theirs to
    // govern the way teammates' personal MCP servers are.
    const visible = rows.filter((row) => row.connection.ownerId === me || access.canManage);

    // Names for the pinned projects, so the UI can say what a selection
    // reaches without a request per row. A project no longer in the
    // organization simply has no name here, which reads as out of scope.
    const pinnedIds = [...new Set(visible.flatMap((row) => row.connection.projectIds))];
    const named = pinnedIds.length
      ? await db(c, ctx)
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(inArray(projects.id, pinnedIds), orgProjectFilter(access.organizationId, me)))
      : [];
    const nameOf = new Map(named.map((p) => [p.id, p.name]));

    return c.json({
      canManage: access.canManage,
      connections: visible.map((row) => ({
        id: row.connection.id,
        name: row.connection.name,
        scope: row.connection.scope,
        projects: row.connection.projectIds.map((id) => ({ id, name: nameOf.get(id) ?? null })),
        tokenHint: row.connection.tokenHint,
        mine: row.connection.ownerId === me,
        ownerName: row.connection.ownerId === me ? null : (row.ownerName ?? null),
        lastUsedAt: row.connection.lastUsedAt,
        requestCount: row.connection.requestCount,
        createdAt: row.connection.createdAt,
      })),
    });
  });

  routes.post("/", zValidator("json", createConnection), async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const body = c.req.valid("json");
    if (body.scope === "projects" && body.projectIds.length === 0) {
      return c.json({ error: "pick at least one project, or grant the whole team" }, 400);
    }

    // Every pinned project must be one the caller's organization holds
    // right now. An id from the body is a claim, not a fact.
    const projectIds = body.scope === "projects" ? [...new Set(body.projectIds)] : [];
    if (projectIds.length > 0) {
      const held = await db(c, ctx)
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.id, projectIds), orgProjectFilter(access.organizationId, actor(c))));
      if (held.length !== projectIds.length) return notFound(c);
    }

    const token = mintConnectionToken();
    const [row] = await db(c, ctx)
      .insert(mcpConnections)
      .values({
        ownerId: actor(c),
        organizationId: access.organizationId,
        name: body.name,
        scope: body.scope,
        projectIds,
        tokenHash: token.hash,
        tokenHint: token.hint,
      })
      .returning();
    if (!row) return c.json({ error: "something went wrong saving the connection; try again" }, 500);
    // The one time the raw token exists in a response. It is the
    // caller's to store; only the hash survives here.
    return c.json(
      {
        id: row.id,
        name: row.name,
        scope: row.scope,
        projectIds: row.projectIds,
        tokenHint: row.tokenHint,
        token: token.raw,
      },
      201,
    );
  });

  routes.delete("/:id", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound(c);
    const [row] = await db(c, ctx)
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.id, id), orgFilter(access.organizationId)))
      .limit(1);
    if (!row) return notFound(c);
    if (row.ownerId !== actor(c) && !access.canManage) return notFound(c);
    await db(c, ctx).delete(mcpConnections).where(eq(mcpConnections.id, row.id));
    return c.json({ ok: true });
  });

  /**
   * The mcp.ts requireAccess shape, plus the beta gate: inbound
   * connections are unfinished product, so a non-tester hears 404
   * before anything else is learned.
   */
  async function requireAccess(
    ctx_: AppContext,
    c: Context,
  ): Promise<{ ok: true; organizationId: string | null; canManage: boolean } | { ok: false }> {
    if (!(await getBetaTester(ctx_, c))) return { ok: false };
    const organizationId = activeOrg(c);
    if (organizationId) {
      const [row] = await db(c, ctx_)
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, actor(c))))
        .limit(1);
      if (!row) return { ok: false };
      return { ok: true, organizationId, canManage: row.role === "owner" || row.role === "admin" };
    }
    if (ctx_.env.BENTO_MODE === "multi") return { ok: false };
    return { ok: true, organizationId: null, canManage: true };
  }

  return routes;
}

function orgFilter(organizationId: string | null) {
  return organizationId ? eq(mcpConnections.organizationId, organizationId) : isNull(mcpConnections.organizationId);
}

/**
 * The projects a connection made here may pin: the organization's, or
 * in local mode (and for an org-less caller) the caller's own. The
 * connectionProjectFilter in mcp/connections.ts applies the same rule
 * at serve time.
 */
function orgProjectFilter(organizationId: string | null, ownerId: string) {
  return organizationId
    ? eq(projects.organizationId, organizationId)
    : and(isNull(projects.organizationId), eq(projects.ownerId, ownerId))!;
}
