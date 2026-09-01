import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { mcpCredentials, mcpServers, member, user } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { maskSecret } from "../secrets.js";
import { pingMcpServer } from "../mcp/client.js";
import { safeFetchPolicy } from "../mcp/safe-fetch.js";
import { fetchCatalog, featuredEntries, slugFor } from "../mcp/catalog.js";
import { allowIconHosts, fetchServiceIcon, isIconHostAllowed } from "../mcp/icons.js";
import { detectAuthType } from "../mcp/detect-auth.js";
import { discoverOAuth, registerClient, DiscoveryError } from "../mcp/discovery.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  makePkce,
  signState,
  stateExpiry,
  verifyState,
  OAuthError,
} from "../mcp/oauth.js";

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
  /** Omitted means Bento probes the server and decides. */
  authType: z.enum(["none", "api_key", "oauth"]).optional(),
  credentialScope: z.enum(["org", "user"]).default("org"),
  /** A member's own server: only their runs get it, any member may add one. */
  personal: z.boolean().default(false),
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
    // A member sees the team's servers and their own personal ones;
    // admins additionally see every member's personal servers, named,
    // because governance over what agents can reach is theirs.
    const visible = servers.filter(
      (server) => !server.userId || server.userId === me || access.canManage,
    );
    const ownerIds = [...new Set(visible.map((s) => s.userId).filter((id): id is string => id !== null))];
    const owners = ownerIds.length
      ? await db(c, ctx).select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ownerIds))
      : [];

    const rows = visible.map((server) => {
      const personal = server.userId !== null;
      const mineServer = server.userId === me;
      const org = credentials.find((row) => row.serverId === server.id && row.userId === null) ?? null;
      const myRow = credentials.find((row) => row.serverId === server.id && row.userId === me) ?? null;
      const perUser = server.authType === "oauth" && server.credentialScope === "user";
      return {
        id: server.id,
        name: server.name,
        slug: server.slug,
        url: server.url,
        transport: server.transport,
        authType: server.authType,
        credentialScope: server.credentialScope,
        personal,
        mine: mineServer,
        ownerName: personal ? (owners.find((o) => o.id === server.userId)?.name ?? null) : null,
        enabled: server.enabled,
        apiKeyHeader: server.apiKeyHeader,
        oauthClientConfigured: Boolean(server.clientId),
        orgCredential:
          perUser || personal ? null : org && { connected: true, hint: org.hint, expiresAt: org.expiresAt },
        userCredential:
          personal && mineServer
            ? // A personal server with no auth has nothing to connect.
              { connected: server.authType === "none" || Boolean(myRow), hint: myRow?.hint ?? null }
            : perUser && !personal
              ? { connected: Boolean(myRow), hint: null }
              : null,
      };
    });
    const userConnectionsNeeded = rows.filter(
      (row) => row.enabled && row.userCredential && !row.userCredential.connected,
    ).length;
    return c.json({ canManage: access.canManage, servers: rows, userConnectionsNeeded });
  });

  /**
   * The browsable catalog: what a team can connect, before anyone has
   * to know a URL. Public registry data, so it needs a signed-in caller
   * and nothing more, but it does mark which entries this organization
   * already has so the list reads as a state rather than a menu.
   *
   * A registry that will not load answers reachable:false with an empty
   * list; the console then offers the custom URL form on its own.
   */
  routes.get("/catalog", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const search = c.req.query("search") ?? "";
    const policy = safeFetchPolicy(ctx.env);
    const { entries: found, reachable } = await fetchCatalog(policy, {
      registryUrl: ctx.env.BENTO_MCP_REGISTRY_URL,
      search,
    });

    // Browsing leads with the curated set; a search is answered with
    // what was asked for, in the registry's own order. The curated set
    // needs no registry, so it still leads when the registry is down.
    let entries = found;
    if (!search.trim()) {
      const featured = featuredEntries();
      const pinned = new Set(featured.map((entry) => entry.name));
      entries = [...featured, ...found.filter((entry) => !pinned.has(entry.name))];
    }

    // Mark what is already here, by URL: the same server added by hand
    // and picked from the catalog is one server, not two.
    const existing = await db(c, ctx)
      .select({ url: mcpServers.url, userId: mcpServers.userId })
      .from(mcpServers)
      .where(orgFilter(access.organizationId));
    const me = actor(c);
    const mine = new Set(
      existing.filter((row) => !row.userId || row.userId === me).map((row) => normalizeUrl(row.url)),
    );

    // Only hosts the catalog actually offered may be fetched for an
    // icon, so the icon route cannot be pointed anywhere.
    allowIconHosts(entries.map((entry) => entry.iconHost));

    return c.json({
      reachable,
      canManage: access.canManage,
      entries: entries.map((entry) => ({
        ...entry,
        slug: slugFor(entry),
        added: mine.has(normalizeUrl(entry.url)),
        iconUrl: entry.iconHost ? `/api/mcp/catalog/icon/${encodeURIComponent(entry.iconHost)}` : null,
      })),
    });
  });

  /**
   * A service's own icon, fetched and cached by the server so the
   * console never calls a vendor's domain itself. Only hosts the
   * catalog has offered are fetchable, and anything that is not a small
   * image answers 404, which the console renders as a monogram.
   */
  routes.get("/catalog/icon/:host", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const host = decodeURIComponent(c.req.param("host") ?? "").toLowerCase();
    // The allow list is filled by a catalog read, which happens in
    // whichever process served it. Another process (or one restarted
    // since) has an empty list, so fill it from the cached catalog
    // before refusing, rather than 404ing an icon that is legitimately
    // on offer.
    if (!isIconHostAllowed(host)) {
      const { entries } = await fetchCatalog(safeFetchPolicy(ctx.env), {
        registryUrl: ctx.env.BENTO_MCP_REGISTRY_URL,
      });
      allowIconHosts(entries.map((entry) => entry.iconHost));
    }
    if (!isIconHostAllowed(host)) return c.json({ error: "not found" }, 404);
    const icon = await fetchServiceIcon(host, safeFetchPolicy(ctx.env));
    if (!icon) return c.json({ error: "not found" }, 404);
    c.header("content-type", icon.contentType);
    // Immutable enough: a favicon changing is not worth a revalidation
    // on every settings visit.
    c.header("cache-control", "private, max-age=86400");
    // Agent-adjacent bytes from a third party: never let them be
    // interpreted as anything but an image on our origin.
    c.header("content-security-policy", "sandbox; default-src 'none'");
    c.header("x-content-type-options", "nosniff");
    return c.body(icon.body as unknown as ArrayBuffer);
  });

  /**
   * Line format for the TUI and Mac app, which cannot import the typed
   * client: mcp|<id>|<slug>|<authType>|<scope>|<enabled>|<connected>.
   * connected reflects the org credential, or the caller's own for a
   * per-user server. No route returns a secret; this is no exception.
   */
  routes.get("/plain", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.text("");
    const servers = await db(c, ctx).select().from(mcpServers).where(orgFilter(access.organizationId));
    const credentials = await db(c, ctx)
      .select({ serverId: mcpCredentials.serverId, userId: mcpCredentials.userId })
      .from(mcpCredentials)
      .where(
        access.organizationId
          ? eq(mcpCredentials.organizationId, access.organizationId)
          : isNull(mcpCredentials.organizationId),
      );
    const me = actor(c);
    const lines = servers
      .filter((server) => !server.userId || server.userId === me)
      .map((server) => {
        const personal = server.userId !== null;
        const perUser = personal || (server.authType === "oauth" && server.credentialScope === "user");
        const connected =
          server.authType === "none"
            ? true
            : perUser
              ? credentials.some((r) => r.serverId === server.id && r.userId === me)
              : credentials.some((r) => r.serverId === server.id && r.userId === null);
        const scope = personal ? "personal" : server.credentialScope;
        return `mcp|${server.id}|${server.slug}|${server.authType}|${scope}|${server.enabled}|${connected}`;
      });
    return c.text(lines.join("\n"));
  });

  routes.post("/", zValidator("json", createServer), async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");
    // A team server is org infrastructure and stays admin gated. A
    // personal server is the member's own: any member may add one, it
    // reaches only runs they start, and only their own credential ever
    // rides through the gateway for it.
    if (!body.personal && !access.canManage) {
      return c.json({ error: "organization admin required" }, 403);
    }
    // Adding from the catalog says nothing about auth, because the
    // server itself knows. Ask it rather than making somebody guess.
    const authType = body.authType ?? (await detectAuthType(body.url, body.transport, safeFetchPolicy(ctx.env)));
    try {
      const [row] = await db(c, ctx)
        .insert(mcpServers)
        .values({
          ownerId: actor(c),
          organizationId: access.organizationId,
          userId: body.personal ? actor(c) : null,
          name: body.name,
          slug: body.slug,
          url: body.url,
          transport: body.transport,
          authType,
          // A personal server is always its owner's own credential.
          credentialScope: body.personal ? "user" : authType === "oauth" ? body.credentialScope : "org",
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
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");
    const right = personalRight(server, actor(c), access.canManage);
    if (right === "none") return c.json({ error: "not found" }, 404);
    if (right === "team" && !access.canManage) {
      return c.json({ error: "organization admin required" }, 403);
    }
    // An admin can switch another member's personal server off (or back
    // on), which is governance; its shape stays the owner's to edit.
    if (right === "admin") {
      const touched = Object.entries(body).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (touched.some((key) => key !== "enabled")) {
        return c.json({ error: "only the owner can edit a personal server" }, 403);
      }
    }

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
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    const right = personalRight(server, actor(c), access.canManage);
    if (right === "none") return c.json({ error: "not found" }, 404);
    // A personal server can be removed by its owner or, as governance,
    // by an admin; a team server stays admin only.
    if (right === "team" && !access.canManage) {
      return c.json({ error: "organization admin required" }, 403);
    }
    await db(c, ctx).delete(mcpServers).where(eq(mcpServers.id, server.id));
    return c.json({ ok: true });
  });

  routes.post(
    "/:id/api-key",
    zValidator("json", z.object({ value: z.string().min(1).max(8192) })),
    async (c) => {
      const access = await requireAccess(ctx, c);
      if (!access.ok) return c.json({ error: "not found" }, 404);
      const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
      if (!server) return c.json({ error: "not found" }, 404);
      const right = personalRight(server, actor(c), access.canManage);
      if (right === "none") return c.json({ error: "not found" }, 404);
      if (right === "team" && !access.canManage) {
        return c.json({ error: "organization admin required" }, 403);
      }
      // A personal server's key is the owner's own; not even an admin
      // stores one on their behalf.
      if (right === "admin") {
        return c.json({ error: "only the owner can store a key for a personal server" }, 403);
      }
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

      // A team server's key is the org row (user_id null); a personal
      // server's key belongs to its owner.
      const credentialUserId = server.userId ? actor(c) : null;
      const values = {
        serverId: server.id,
        organizationId: access.organizationId,
        userId: credentialUserId,
        kind: "api_key" as const,
        encryptedSecret: ctx.secretBox.encrypt(value),
        hint: maskSecret(value),
      };
      const set = {
        encryptedSecret: values.encryptedSecret,
        hint: values.hint,
        kind: values.kind,
        updatedAt: new Date(),
      };
      // The org credential row has a null user_id, so its upsert must
      // target the partial index, not the composite one: PostgreSQL
      // treats nulls as distinct in a composite unique index.
      if (credentialUserId) {
        await db(c, ctx)
          .insert(mcpCredentials)
          .values(values)
          .onConflictDoUpdate({ target: [mcpCredentials.serverId, mcpCredentials.userId], set });
      } else {
        await db(c, ctx)
          .insert(mcpCredentials)
          .values(values)
          .onConflictDoUpdate({
            target: mcpCredentials.serverId,
            targetWhere: isNull(mcpCredentials.userId),
            set,
          });
      }
      return c.json({ ok: true, hint: values.hint }, 201);
    },
  );

  routes.delete("/:id/credential", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    const right = personalRight(server, actor(c), access.canManage);
    if (right === "none") return c.json({ error: "not found" }, 404);
    if (right === "team" && !access.canManage) {
      return c.json({ error: "organization admin required" }, 403);
    }
    if (right === "admin") {
      return c.json({ error: "only the owner can disconnect a personal server" }, 403);
    }
    await db(c, ctx)
      .delete(mcpCredentials)
      .where(
        and(
          eq(mcpCredentials.serverId, server.id),
          server.userId ? eq(mcpCredentials.userId, server.userId) : isNull(mcpCredentials.userId),
        ),
      );
    return c.json({ ok: true });
  });

  /**
   * Begins an OAuth connection. An org-scoped server is an admin action;
   * a per-user server any member connects for themselves. Discovers and
   * caches the authorization server, registers a client if the server
   * offers dynamic registration, and returns the authorization URL plus
   * the host it points at (so the UI can show where it is sending
   * someone before it redirects).
   */
  routes.post("/:id/connect", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    if (server.authType !== "oauth") return c.json({ error: "this server does not use OAuth" }, 400);
    // A personal server: only its owner ever connects it. Everyone else,
    // admin or not, sees a 404 or is refused.
    if (server.userId) {
      const right = personalRight(server, actor(c), access.canManage);
      if (right === "none") return c.json({ error: "not found" }, 404);
      if (right === "admin") {
        return c.json({ error: "only the owner can connect a personal server" }, 403);
      }
    }
    const perUser = server.credentialScope === "user";
    if (!server.userId && !perUser && !access.canManage) {
      return c.json({ error: "organization admin required" }, 403);
    }

    const secret = stateSecret(ctx);
    if (!secret) return c.json({ error: "this server has no signing key configured" }, 503);
    const policy = safeFetchPolicy(ctx.env);
    const redirectUri = callbackUrl(ctx, server.id);

    // Discover the endpoints if they are not cached yet.
    let authorizationEndpoint = server.authorizationEndpoint;
    let tokenEndpoint = server.tokenEndpoint;
    let issuer = server.issuer;
    let resource = server.resource ?? server.url;
    let registrationEndpoint = server.registrationEndpoint;
    if (!authorizationEndpoint || !tokenEndpoint) {
      try {
        const discovered = await discoverOAuth(server.url, policy);
        authorizationEndpoint = discovered.authorizationEndpoint;
        tokenEndpoint = discovered.tokenEndpoint;
        issuer = discovered.issuer;
        resource = discovered.resource;
        registrationEndpoint = discovered.registrationEndpoint;
        await db(c, ctx)
          .update(mcpServers)
          .set({
            authorizationEndpoint,
            tokenEndpoint,
            registrationEndpoint,
            issuer,
            resource,
            issParamSupported: discovered.issParameterSupported,
            metadataDiscoveredAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, server.id));
      } catch (err) {
        if (err instanceof DiscoveryError) return c.json({ error: err.message }, 502);
        throw err;
      }
    }

    // Register a client if there is no manually entered one and the
    // authorization server offers dynamic registration.
    let clientId = server.clientId;
    if (!clientId) {
      if (!registrationEndpoint) {
        return c.json(
          { error: "this server needs a client id and secret; enter them and try again", needsManualClient: true },
          409,
        );
      }
      try {
        const registered = await registerClient(registrationEndpoint, redirectUri, policy);
        clientId = registered.clientId;
        await db(c, ctx)
          .update(mcpServers)
          .set({
            clientId: registered.clientId,
            encryptedClientSecret: registered.clientSecret
              ? ctx.secretBox.encrypt(registered.clientSecret)
              : null,
            clientRegistration: "dynamic",
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, server.id));
      } catch (err) {
        if (err instanceof DiscoveryError) {
          return c.json({ error: err.message, needsManualClient: true }, 409);
        }
        throw err;
      }
    }

    const pkce = makePkce();
    const state = signState(
      {
        userId: actor(c),
        organizationId: access.organizationId,
        serverId: server.id,
        scope: perUser ? "user" : "org",
        verifierEnc: ctx.secretBox.encrypt(pkce.verifier),
        expiresAt: stateExpiry(),
      },
      secret,
    );
    const url = buildAuthorizeUrl({
      authorizationEndpoint: authorizationEndpoint!,
      clientId: clientId!,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      resource,
      scope: server.scopes,
    });
    return c.json({ url, authorizationHost: new URL(authorizationEndpoint!).host });
  });

  /**
   * The OAuth redirect target, one path per server. The server id in the
   * path must match the id the state was minted for, so a code issued by
   * one server's authorization server can never be redeemed through
   * another's callback: that, with the per-server redirect_uri each
   * server registers, is the mix-up defense.
   */
  routes.get("/callback/:serverId", async (c) => {
    const secret = stateSecret(ctx);
    if (!secret) return outcome(c, "unconfigured");
    const state = verifyState(c.req.query("state"), secret);
    const pathServerId = c.req.param("serverId");
    if (!state || state.expiresAt < Date.now() || state.serverId !== pathServerId) {
      return outcome(c, "invalid");
    }
    if (state.userId !== actor(c)) return outcome(c, "invalid");
    if ((activeOrg(c) ?? null) !== state.organizationId) return outcome(c, "organization");

    // Live membership re-check, minutes after connect began.
    if (state.organizationId) {
      const [row] = await db(c, ctx)
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, state.organizationId), eq(member.userId, actor(c))))
        .limit(1);
      if (!row) return outcome(c, "denied");
      if (state.scope === "org" && row.role !== "owner" && row.role !== "admin") return outcome(c, "denied");
    } else if (ctx.env.BENTO_MODE === "multi") {
      return outcome(c, "denied");
    }

    const server = await serverFor(ctx, c, state.organizationId, state.serverId);
    if (!server || server.authType !== "oauth" || !server.tokenEndpoint || !server.clientId) {
      return outcome(c, "invalid");
    }
    // A personal server's connection lands only on its owner, whatever
    // the state claims: the row's user id is the authority.
    if (server.userId && server.userId !== actor(c)) return outcome(c, "denied");

    // RFC 9207: an issuer on the response must match the one we
    // discovered, and when the authorization server advertised that it
    // returns one, a response that omits it is refused. The per-server
    // callback path and redirect_uri pin the exchange on top of this.
    const iss = c.req.query("iss");
    if (iss) {
      if (server.issuer && iss !== server.issuer) return outcome(c, "invalid");
    } else if (server.issParamSupported) {
      return outcome(c, "invalid");
    }

    if (c.req.query("error")) return outcome(c, "denied");
    const code = c.req.query("code");
    if (!code) return outcome(c, "invalid");

    let verifier: string;
    try {
      verifier = ctx.secretBox.decrypt(state.verifierEnc);
    } catch {
      return outcome(c, "invalid");
    }

    let tokens;
    try {
      tokens = await exchangeCode(
        {
          tokenEndpoint: server.tokenEndpoint,
          clientId: server.clientId,
          clientSecret: server.encryptedClientSecret
            ? ctx.secretBox.decrypt(server.encryptedClientSecret)
            : null,
          redirectUri: callbackUrl(ctx, server.id),
          code,
          codeVerifier: verifier,
          resource: server.resource ?? server.url,
        },
        safeFetchPolicy(ctx.env),
      );
    } catch (err) {
      if (err instanceof OAuthError) {
        // The message carries the provider's own error code and no
        // secret, and without it a failed connect is undiagnosable:
        // the console can only say the sign in did not complete.
        console.warn(
          `[mcp] token exchange failed for ${server.name} at ${new URL(server.tokenEndpoint).host}: ${err.message}`,
        );
        return outcome(c, "failed");
      }
      throw err;
    }

    const userId = state.scope === "user" ? actor(c) : null;
    const values = {
      serverId: server.id,
      organizationId: state.organizationId,
      userId,
      kind: "oauth" as const,
      encryptedSecret: ctx.secretBox.encrypt(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? ctx.secretBox.encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      tokenEndpointOrigin: new URL(server.tokenEndpoint).origin,
      hint: "",
    };
    // Null user id is distinct in the composite index, so an org
    // credential targets the partial index (secrets.ts pattern).
    if (userId) {
      await db(c, ctx)
        .insert(mcpCredentials)
        .values(values)
        .onConflictDoUpdate({ target: [mcpCredentials.serverId, mcpCredentials.userId], set: refreshableSet(values) });
    } else {
      await db(c, ctx)
        .insert(mcpCredentials)
        .values(values)
        .onConflictDoUpdate({
          target: mcpCredentials.serverId,
          targetWhere: isNull(mcpCredentials.userId),
          set: refreshableSet(values),
        });
    }
    return outcome(c, "connected");
  });

  /** A member removes their own connection to a per-user server. */
  routes.delete("/:id/user-credential", async (c) => {
    const access = await requireAccess(ctx, c);
    if (!access.ok) return c.json({ error: "not found" }, 404);
    const server = await serverFor(ctx, c, access.organizationId, c.req.param("id"));
    if (!server) return c.json({ error: "not found" }, 404);
    // Another member's personal server does not exist as far as this
    // caller can tell; a 200 here would say otherwise.
    if (personalRight(server, actor(c), access.canManage) === "none") {
      return c.json({ error: "not found" }, 404);
    }
    await db(c, ctx)
      .delete(mcpCredentials)
      .where(and(eq(mcpCredentials.serverId, server.id), eq(mcpCredentials.userId, actor(c))));
    return c.json({ ok: true });
  });

  return routes;
}

/**
 * What the caller may do with a server, given who owns it. A team
 * server (no user id) answers "team" and the route applies its own
 * admin gate; a personal server answers owner, admin (governance:
 * disable and delete only), or none, and none must read as 404 so a
 * member cannot learn what personal servers their teammates run.
 */
function personalRight(
  server: { userId: string | null },
  me: string,
  canManage: boolean,
): "team" | "owner" | "admin" | "none" {
  if (!server.userId) return "team";
  if (server.userId === me) return "owner";
  if (canManage) return "admin";
  return "none";
}

/** The columns an upsert replaces when a credential is reconnected. */
function refreshableSet(values: {
  encryptedSecret: string;
  encryptedRefreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  tokenEndpointOrigin: string;
}) {
  return {
    encryptedSecret: values.encryptedSecret,
    encryptedRefreshToken: values.encryptedRefreshToken,
    expiresAt: values.expiresAt,
    scope: values.scope,
    tokenEndpointOrigin: values.tokenEndpointOrigin,
    kind: "oauth" as const,
    updatedAt: new Date(),
  };
}

function stateSecret(ctx: AppContext): string | undefined {
  return ctx.env.BENTO_SECRET_KEY ?? ctx.env.BETTER_AUTH_SECRET;
}

function callbackUrl(ctx: AppContext, serverId: string): string {
  return `${ctx.env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/mcp/callback/${serverId}`;
}

function outcome(c: Parameters<typeof actor>[0], result: string) {
  return c.redirect(`/settings?tab=mcp&mcp=${result}`);
}

/** Compares server URLs ignoring a trailing slash and case in the host. */
function normalizeUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return value.trim().toLowerCase();
  }
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
