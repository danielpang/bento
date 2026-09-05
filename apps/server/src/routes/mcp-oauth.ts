import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  mcpConnections,
  mcpOAuthClients,
  mcpOAuthCodes,
  mcpOAuthRequests,
  member,
  projects,
} from "@bento/db";
import type { AppContext } from "../context.js";
import { getBetaTester } from "../feature-flags.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb } from "../middleware/tenant.js";
import {
  hashConnectionToken,
  mintAuthorizationCode,
  mintConnectionToken,
  mintRefreshToken,
} from "../mcp/connections.js";
import {
  ACCESS_TOKEN_EXPIRES_IN,
  AUTH_TTL_MS,
  canonicalResource,
  clientRedirect,
  isAllowedRedirectUri,
  oauthErrorRedirect,
  pkceMatches,
  requestOrigin,
  resourceAllowed,
} from "../mcp/oauth-as.js";

/**
 * Public OAuth endpoints for Bento as an MCP server: dynamic client
 * registration, the authorize redirect, and the token exchange.
 * Callers are Claude, Cursor, and other MCP hosts, not a signed-in
 * session, so this sits outside actor and tenant middleware and runs
 * on the owner pool.
 */
export function mcpOAuthPublicRoutes(ctx: AppContext) {
  const routes = new Hono();

  routes.post("/register", async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: "invalid_client_metadata" }, 400);
    const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) : "";
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 10) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    if (redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    const clientId = `mcp_${crypto.randomUUID().replace(/-/g, "")}`;
    await ctx.db.insert(mcpOAuthClients).values({
      clientId,
      clientName: name || "MCP client",
      redirectUris,
      tokenEndpointAuthMethod: "none",
    });
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name || "MCP client",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  routes.get("/authorize", async (c) => {
    const origin = requestOrigin(c, ctx.env.BETTER_AUTH_URL);
    const iss = origin;
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? null;
    const responseType = c.req.query("response_type") ?? "";
    const challenge = c.req.query("code_challenge") ?? "";
    const method = c.req.query("code_challenge_method") ?? "";
    const resource = c.req.query("resource") ?? canonicalResource(origin);
    const scope = c.req.query("scope") ?? null;

    const [client] = clientId
      ? await ctx.db.select().from(mcpOAuthClients).where(eq(mcpOAuthClients.clientId, clientId)).limit(1)
      : [];
    const redirectOk = Boolean(client && client.redirectUris.includes(redirectUri) && isAllowedRedirectUri(redirectUri));

    const fail = (error: string) => {
      if (redirectOk) return c.redirect(oauthErrorRedirect(redirectUri, error, state, iss), 302);
      return c.json({ error }, 400);
    };

    if (!client) return fail("invalid_client");
    if (!redirectOk) return c.json({ error: "invalid_request" }, 400);
    if (responseType !== "code") return fail("unsupported_response_type");
    if (method !== "S256" || !challenge) return fail("invalid_request");
    if (!resourceAllowed(resource, origin)) return fail("invalid_target");

    const [request] = await ctx.db
      .insert(mcpOAuthRequests)
      .values({
        clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
        resource,
        scope,
        expiresAt: new Date(Date.now() + AUTH_TTL_MS),
      })
      .returning();
    if (!request) return fail("server_error");
    return c.redirect(`${origin}/connect-mcp?request=${request.id}`, 302);
  });

  routes.post("/token", async (c) => {
    const params = await readTokenParams(c);
    if (!params) return c.json({ error: "invalid_request" }, 400);
    const grant = params.grant_type;
    if (grant === "authorization_code") return exchangeCode(ctx, c, params);
    if (grant === "refresh_token") return refreshGrant(ctx, params);
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return routes;
}

async function exchangeCode(ctx: AppContext, c: Context, params: Record<string, string>) {
  const origin = requestOrigin(c, ctx.env.BETTER_AUTH_URL);
  const code = params.code ?? "";
  const verifier = params.code_verifier ?? "";
  const redirectUri = params.redirect_uri ?? "";
  const clientId = params.client_id ?? "";
  const resource = params.resource;
  if (!code || !verifier || !redirectUri || !clientId) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const [row] = await ctx.db
    .select()
    .from(mcpOAuthCodes)
    .where(and(eq(mcpOAuthCodes.codeHash, hashConnectionToken(code)), gt(mcpOAuthCodes.expiresAt, new Date())))
    .limit(1);
  if (!row) return c.json({ error: "invalid_grant" }, 400);
  if (row.clientId !== clientId || row.redirectUri !== redirectUri) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  if (!pkceMatches(verifier, row.codeChallenge)) return c.json({ error: "invalid_grant" }, 400);
  if (resource && resource.replace(/\/$/, "") !== row.resource.replace(/\/$/, "") && !resourceAllowed(resource, origin)) {
    return c.json({ error: "invalid_target" }, 400);
  }

  let bundle: { access: string; refresh: string };
  try {
    bundle = JSON.parse(ctx.secretBox.decrypt(row.tokenBundle)) as { access: string; refresh: string };
  } catch {
    await ctx.db.delete(mcpOAuthCodes).where(eq(mcpOAuthCodes.id, row.id));
    return c.json({ error: "invalid_grant" }, 400);
  }
  if (typeof bundle.access !== "string" || typeof bundle.refresh !== "string") {
    await ctx.db.delete(mcpOAuthCodes).where(eq(mcpOAuthCodes.id, row.id));
    return c.json({ error: "invalid_grant" }, 400);
  }

  await ctx.db.delete(mcpOAuthCodes).where(eq(mcpOAuthCodes.id, row.id));
  return c.json({
    access_token: bundle.access,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_EXPIRES_IN,
    refresh_token: bundle.refresh,
    scope: "mcp",
  });
}

async function refreshGrant(ctx: AppContext, params: Record<string, string>) {
  const refresh = params.refresh_token ?? "";
  const clientId = params.client_id ?? "";
  if (!refresh) return c.json({ error: "invalid_request" }, 400);
  const [connection] = await ctx.db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.refreshTokenHash, hashConnectionToken(refresh)))
    .limit(1);
  if (!connection) return c.json({ error: "invalid_grant" }, 400);
  if (clientId && connection.oauthClientId && connection.oauthClientId !== clientId) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  // Rotate both tokens. The client stores the new pair; the member
  // does not sign in again. Disconnect is still what ends the grant.
  const access = mintConnectionToken();
  const nextRefresh = mintRefreshToken();
  await ctx.db
    .update(mcpConnections)
    .set({
      tokenHash: access.hash,
      tokenHint: access.hint,
      refreshTokenHash: nextRefresh.hash,
    })
    .where(eq(mcpConnections.id, connection.id));

  return c.json({
    access_token: access.raw,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_EXPIRES_IN,
    refresh_token: nextRefresh.raw,
    scope: "mcp",
  });
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readTokenParams(c: Context): Promise<Record<string, string> | null> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await readJson(c);
    if (!body) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  try {
    const text = await c.req.text();
    const form = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
  } catch {
    return null;
  }
}

const consentBody = z.object({
  request: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  scope: z.enum(["organization", "projects"]),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
});

const denyBody = z.object({ request: z.string().uuid() });

/**
 * The signed-in consent page. Creating the connection is the same act
 * as Settings → New connection, with the client name as the default
 * label. Mounted on the actor and tenant path. Authorization codes are
 * written on the owner pool: bento_user has no INSERT on that table.
 */
export function mcpOAuthConsentRoutes(ctx: AppContext) {
  const routes = new Hono();
  const notFound = (c: Context) => c.json({ error: "not found" }, 404);

  routes.get("/consent", async (c) => {
    const access = await requireConsentAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const request = await loadRequest(ctx, c.req.query("request") ?? "");
    if (!request) return notFound(c);
    if (request.userId && request.userId !== access.userId) return notFound(c);
    if (!request.userId) {
      await ctx.db.update(mcpOAuthRequests).set({ userId: access.userId }).where(eq(mcpOAuthRequests.id, request.id));
    }
    const [client] = await ctx.db
      .select()
      .from(mcpOAuthClients)
      .where(eq(mcpOAuthClients.clientId, request.clientId))
      .limit(1);
    return c.json({
      request: request.id,
      clientName: client?.clientName || "An MCP client",
      redirectUri: request.redirectUri,
    });
  });

  routes.post("/consent", async (c) => {
    const access = await requireConsentAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const parsed = consentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const body = parsed.data;
    if (body.scope === "projects" && body.projectIds.length === 0) {
      return c.json({ error: "pick at least one project, or grant the whole team" }, 400);
    }

    const request = await loadRequest(ctx, body.request);
    if (!request) return notFound(c);
    if (request.userId && request.userId !== access.userId) return notFound(c);

    const origin = requestOrigin(c, ctx.env.BETTER_AUTH_URL);
    const db = tenantDb(c, ctx);
    const projectIds = body.scope === "projects" ? [...new Set(body.projectIds)] : [];
    if (projectIds.length > 0) {
      const held = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            inArray(projects.id, projectIds),
            access.organizationId
              ? eq(projects.organizationId, access.organizationId)
              : and(isNull(projects.organizationId), eq(projects.ownerId, access.userId))!,
          ),
        );
      if (held.length !== projectIds.length) return notFound(c);
    }

    const [client] = await ctx.db
      .select()
      .from(mcpOAuthClients)
      .where(eq(mcpOAuthClients.clientId, request.clientId))
      .limit(1);
    const name = body.name?.trim() || client?.clientName || "MCP client";
    const accessToken = mintConnectionToken();
    const refreshToken = mintRefreshToken();
    const code = mintAuthorizationCode();

    const [connection] = await db
      .insert(mcpConnections)
      .values({
        ownerId: access.userId,
        organizationId: access.organizationId,
        name,
        scope: body.scope,
        projectIds,
        tokenHash: accessToken.hash,
        tokenHint: accessToken.hint,
        refreshTokenHash: refreshToken.hash,
        oauthClientId: request.clientId,
      })
      .returning();
    if (!connection) return c.json({ error: "something went wrong saving the connection; try again" }, 500);

    await ctx.db.insert(mcpOAuthCodes).values({
      codeHash: code.hash,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      connectionId: connection.id,
      organizationId: access.organizationId,
      tokenBundle: ctx.secretBox.encrypt(JSON.stringify({ access: accessToken.raw, refresh: refreshToken.raw })),
      expiresAt: new Date(Date.now() + AUTH_TTL_MS),
    });
    await ctx.db.delete(mcpOAuthRequests).where(eq(mcpOAuthRequests.id, request.id));

    return c.json({
      redirect: clientRedirect(request.redirectUri, {
        code: code.raw,
        ...(request.state ? { state: request.state } : {}),
        iss: origin,
      }),
    });
  });

  routes.post("/deny", async (c) => {
    const access = await requireConsentAccess(ctx, c);
    if (!access.ok) return notFound(c);
    const parsed = denyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const request = await loadRequest(ctx, parsed.data.request);
    if (!request) return notFound(c);
    if (request.userId && request.userId !== access.userId) return notFound(c);
    const origin = requestOrigin(c, ctx.env.BETTER_AUTH_URL);
    await ctx.db.delete(mcpOAuthRequests).where(eq(mcpOAuthRequests.id, request.id));
    return c.json({
      redirect: oauthErrorRedirect(request.redirectUri, "access_denied", request.state, origin),
    });
  });

  return routes;
}

async function loadRequest(ctx: AppContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await ctx.db
    .select()
    .from(mcpOAuthRequests)
    .where(and(eq(mcpOAuthRequests.id, id), gt(mcpOAuthRequests.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

async function requireConsentAccess(
  ctx: AppContext,
  c: Context,
): Promise<{ ok: true; userId: string; organizationId: string | null } | { ok: false }> {
  if (!(await getBetaTester(ctx, c))) return { ok: false };
  const userId = actor(c);
  const organizationId = activeOrg(c);
  if (organizationId) {
    const [row] = await tenantDb(c, ctx)
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
      .limit(1);
    if (!row) return { ok: false };
    return { ok: true, userId, organizationId };
  }
  if (ctx.env.BENTO_MODE === "multi") return { ok: false };
  return { ok: true, userId, organizationId: null };
}
