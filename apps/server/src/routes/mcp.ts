import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { mcpCredentials, mcpServers, member } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { maskSecret } from "../secrets.js";
import { pingMcpServer } from "../mcp/client.js";
import { safeFetchPolicy } from "../mcp/safe-fetch.js";

/**
 * Org-defined MCP servers, the registry every agent harness draws from.
 *
 * Definitions are admin-managed. Credentials are write-only and
 * encrypted at rest: no route returns plaintext, runs are handed a
 * gateway URL plus a run-scoped token instead of anything real, and the
 * gateway attaches the stored credential server side.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Headers the gateway itself speaks, or that shape the upstream
 * request. An API key must not be able to ride in one of these.
 */
const RESERVED_API_KEY_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "accept",
  "mcp-session-id",
  "last-event-id",
  "mcp-protocol-version",
]);

const apiKeyHeaderField = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "header names use letters, digits, and dashes")
  .refine((name) => !RESERVED_API_KEY_HEADERS.has(name.toLowerCase()), {
    message: "this header is reserved by the gateway",
  });

const urlField = z.string().max(2048).superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not a valid URL" });
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only http(s) MCP servers are supported" });
  }
});

const createServer = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(SLUG_PATTERN, "slugs are lowercase letters, digits, and dashes"),
  url: urlField,
  transport: z.enum(["http", "sse"]).default("http"),
  authType: z.enum(["none", "api_key", "oauth"]),
  credentialScope: z.enum(["org", "user"]).default("org"),
  apiKeyHeader: apiKeyHeaderField.default("Authorization"),
  clientId: z.string().min(1).max(512).optional(),
  clientSecret: z.string().min(1).max(2048).optional(),
  scopes: z.string().max(1024).optional(),
});

const patchServer = z.object({
  name: z.string().min(1).max(120).optional(),
  url: urlField.optional(),
  transport: z.enum(["http", "sse"]).optional(),
  authType: z.enum(["none", "api_key", "oauth"]).optional(),
  credentialScope: z.enum(["org", "user"]).optional(),
  enabled: z.boolean().optional(),
  apiKeyHeader: apiKeyHeaderField.optional(),
  clientId: z.string().min(1).max(512).nullable().optional(),
  clientSecret: z.string().min(1).max(2048).nullable().optional(),
  scopes: z.string().max(1024).nullable().optional(),
});

export function mcpRoutes(ctx: AppContext) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const servers = await db(c, ctx)
      .select()
      .from(mcpServers)
      .where(orgFilter(access.organizationId))
      .orderBy(mcpServers.createdAt);
    const credentials = await db(c, ctx)
      .select({
        serverId: mcpCredentials.serverId,
        userId: mcpCredentials.userId,
        hint: mcpCredentials.hint,
        expiresAt: mcpCredentials.expiresAt,
      })
      .from(mcpCredentials)
      .where(
        access.organizationId
          ? eq(mcpCredentials.organizationId, access.organizationId)
          : isNull(mcpCredentials.organizationId),
      );

    const me = actor(c);
    const rows = servers.map((server) => {
      const org = credentials.find((row) => row.serverId === server.id && row.userId === null) ?? null;
      const mine = credentials.some((row) => row.serverId === server.id && row.userId === me);
      const perUser = server.authType === "oauth" && server.credentialScope === "user";
      return {
        id: server.id,
        name: server.name,
        slug: server.slug,
        url: server.url,
        transport: server.transport,
        authType: server.authType,
        credentialScope: server.credentialScope,
        enabled: server.enabled,
        apiKeyHeader: server.apiKeyHeader,
        oauthClientConfigured: Boolean(server.clientId),
        orgCredential: perUser
          ? null
          : org && { connected: true, hint: org.hint, expiresAt: org.expiresAt },
        userCredential: perUser ? { connected: mine } : null,
      };
    });
    const userConnectionsNeeded = rows.filter(
      (row) => row.enabled && row.userCredential && !row.userCredential.connected,
    ).length;
    return c.json({ canManage: access.canManage, servers: rows, userConnectionsNeeded });
  });

  routes.post("/", zValidator("json", createServer), async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const body = c.req.valid("json");
    try {
      const [row] = await db(c, ctx)
        .insert(mcpServers)
        .values({
          ownerId: actor(c),
          organizationId: access.organizationId,
          name: body.name,
          slug: body.slug,
          url: body.url,
          transport: body.transport,
          authType: body.authType,
          credentialScope: body.authType === "oauth" ? body.credentialScope : "org",
          apiKeyHeader: body.apiKeyHeader,
          clientId: body.clientId ?? null,
          encryptedClientSecret: body.clientSecret ? ctx.secretBox.encrypt(body.clientSecret) : null,
          clientRegistration: body.clientId ? ("manual" as const) : null,
          scopes: body.scopes ?? null,
        })
        .returning();
      return c.json({ id: row!.id }, 201);
    } catch {
      return c.json({ error: "a server with this slug already exists" }, 409);
    }
  });

  routes.patch("/:id", zValidator("json", patchServer), async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");

    // Repointing a server must not carry its credentials along: the
    // gateway attaches secrets to whatever URL the row holds, so a
    // changed origin, auth type, or scope would hand every stored token
    // to the new destination. Wipe and make people reconnect.
    const originChanged = body.url !== undefined && origin(body.url) !== origin(server.url);
    const authChanged = body.authType !== undefined && body.authType !== server.authType;
    const scopeChanged = body.credentialScope !== undefined && body.credentialScope !== server.credentialScope;
    const wipe = originChanged || authChanged || scopeChanged;

    const update: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.url !== undefined) update.url = body.url;
    if (body.transport !== undefined) update.transport = body.transport;
    if (body.authType !== undefined) update.authType = body.authType;
    if (body.credentialScope !== undefined) update.credentialScope = body.credentialScope;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.apiKeyHeader !== undefined) update.apiKeyHeader = body.apiKeyHeader;
    if (body.clientId !== undefined) {
      update.clientId = body.clientId;
      update.clientRegistration = body.clientId ? ("manual" as const) : null;
    }
    if (body.clientSecret !== undefined) {
      update.encryptedClientSecret = body.clientSecret ? ctx.secretBox.encrypt(body.clientSecret) : null;
    }
    if (body.scopes !== undefined) update.scopes = body.scopes;
    if (wipe) {
      update.authorizationEndpoint = null;
      update.tokenEndpoint = null;
      update.registrationEndpoint = null;
      update.issuer = null;
      update.resource = null;
      update.metadataDiscoveredAt = null;
      // A dynamically registered client belongs to the old endpoints; a
      // manually entered one is the admin's to keep or change.
      if (server.clientRegistration === "dynamic" && body.clientId === undefined) {
        update.clientId = null;
        update.encryptedClientSecret = null;
        update.clientRegistration = null;
      }
      await db(c, ctx).delete(mcpCredentials).where(eq(mcpCredentials.serverId, server.id));
    }

    await db(c, ctx).update(mcpServers).set(update).where(eq(mcpServers.id, server.id));
    return c.json({ ok: true, reconnectRequired: wipe });
  });

  routes.delete("/:id", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    await db(c, ctx).delete(mcpServers).where(eq(mcpServers.id, server.id));
    return c.json({ ok: true });
  });

  routes.post(
    "/:id/api-key",
    zValidator("json", z.object({ value: z.string().min(1).max(8192) })),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
      const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
      if (!server) return c.json({ error: "not found" }, 404);
      if (server.authType !== "api_key") {
        return c.json({ error: "this server does not use an API key" }, 400);
      }
      const { value } = c.req.valid("json");

      // Validate before storing, the Linear precedent: a key the
      // upstream refuses should never be saved as "connected".
      const ping = await pingMcpServer(
        { url: server.url, transport: server.transport, apiKeyHeader: server.apiKeyHeader },
        value,
        safeFetchPolicy(ctx.env),
      );
      if (!ping.ok) return c.json({ error: ping.error }, 400);

      const values = {
        serverId: server.id,
        organizationId: access.organizationId,
        userId: null,
        kind: "api_key" as const,
        encryptedSecret: ctx.secretBox.encrypt(value),
        hint: maskSecret(value),
      };
      // The org credential row has a null user_id, so the upsert must
      // target the partial index, not the composite one: PostgreSQL
      // treats nulls as distinct in a composite unique index.
      await db(c, ctx)
        .insert(mcpCredentials)
        .values(values)
        .onConflictDoUpdate({
          target: mcpCredentials.serverId,
          targetWhere: isNull(mcpCredentials.userId),
          set: {
            encryptedSecret: values.encryptedSecret,
            hint: values.hint,
            kind: values.kind,
            updatedAt: new Date(),
          },
        });
      return c.json({ ok: true, hint: values.hint }, 201);
    },
  );

  routes.delete("/:id/credential", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    if (!access.canManage) return c.json({ error: "organization admin required" }, 403);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    await db(c, ctx)
      .delete(mcpCredentials)
      .where(and(eq(mcpCredentials.serverId, server.id), isNull(mcpCredentials.userId)));
    return c.json({ ok: true });
  });

  return routes;
}

function orgFilter(organizationId: string | null) {
  return organizationId ? eq(mcpServers.organizationId, organizationId) : isNull(mcpServers.organizationId);
}

async function serverFor(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  organizationId: string | null,
  id: string,
) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await db(c, ctx)
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), orgFilter(organizationId)))
    .limit(1);
  return row ?? null;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

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
