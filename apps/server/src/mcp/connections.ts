import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { mcpConnections, member, projects, user } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * Inbound MCP connections: the tokens outside agents present to Bento's
 * own MCP server. The mirror image of mcp/grants.ts, and it keeps the
 * same discipline: only the sha256 is stored, every refusal is the same
 * null so a probe cannot tell missing from revoked, and membership is
 * re-read live per request so a departed member's tokens stop serving
 * immediately.
 */

const TOKEN_PREFIX = "bmcp_";
const REFRESH_PREFIX = "bmcr_";
const CODE_PREFIX = "bmcc_";

export function hashConnectionToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function mintPrefixed(prefix: string): { raw: string; hash: string; hint: string } {
  const raw = prefix + randomBytes(32).toString("base64url");
  return { raw, hash: hashConnectionToken(raw), hint: `…${raw.slice(-4)}` };
}

/** A fresh access token. The raw value is shown once and never stored. */
export function mintConnectionToken(): { raw: string; hash: string; hint: string } {
  return mintPrefixed(TOKEN_PREFIX);
}

/** A fresh refresh token. Used only on the OAuth token endpoint. */
export function mintRefreshToken(): { raw: string; hash: string } {
  const minted = mintPrefixed(REFRESH_PREFIX);
  return { raw: minted.raw, hash: minted.hash };
}

/** A fresh authorization code. Single use, exchanged for the token pair. */
export function mintAuthorizationCode(): { raw: string; hash: string } {
  const minted = mintPrefixed(CODE_PREFIX);
  return { raw: minted.raw, hash: minted.hash };
}

export interface ResolvedConnection {
  id: string;
  ownerId: string;
  organizationId: string | null;
  scope: "organization" | "projects";
  projectIds: string[];
}

/**
 * The MCP endpoint's authentication: one indexed read by token hash,
 * then the live membership re-read every route check does. Runs on the
 * owner pool because the caller is an agent, not a session; every query
 * that follows must filter by the connection's own scope.
 */
export async function resolveConnection(ctx: AppContext, rawToken: string): Promise<ResolvedConnection | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await ctx.db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.tokenHash, hashConnectionToken(rawToken)))
    .limit(1);
  if (!row) return null;
  if (row.organizationId) {
    const [membership] = await ctx.db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, row.organizationId), eq(member.userId, row.ownerId)))
      .limit(1);
    if (!membership) return null;
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    scope: row.scope,
    projectIds: row.projectIds,
  };
}

/**
 * Which projects this connection reaches, as a WHERE clause.
 *
 * Organization scope is the organization's projects, now and later; in
 * local mode (no organizations) it is the owner's own. Project scope
 * narrows that same set to the ids pinned at authorization, so a
 * project that leaves the organization drops out of reach even though
 * its id is still on the row.
 */
export function connectionProjectFilter(conn: ResolvedConnection): SQL {
  const base = conn.organizationId
    ? eq(projects.organizationId, conn.organizationId)
    : and(eq(projects.ownerId, conn.ownerId), isNull(projects.organizationId))!;
  if (conn.scope === "organization") return base;
  if (conn.projectIds.length === 0) return sql`false`;
  return and(base, inArray(projects.id, conn.projectIds))!;
}

/** The project row when the connection may act on it, else null (404 upstream). */
export async function projectForConnection(ctx: AppContext, conn: ResolvedConnection, projectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const [project] = await ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), connectionProjectFilter(conn)))
    .limit(1);
  return project ?? null;
}

/**
 * Usage without a write per request: the counter flushes at most every
 * few seconds per connection, the recordGrantUse pattern.
 */
const USAGE_FLUSH_MS = 5_000;
const pendingUsage = new Map<string, { count: number; timer: NodeJS.Timeout }>();

export function recordConnectionUse(ctx: AppContext, connectionId: string): void {
  const pending = pendingUsage.get(connectionId);
  if (pending) {
    pending.count += 1;
    return;
  }
  const timer = setTimeout(() => {
    const entry = pendingUsage.get(connectionId);
    pendingUsage.delete(connectionId);
    if (!entry) return;
    void ctx.db
      .update(mcpConnections)
      .set({
        lastUsedAt: new Date(),
        requestCount: sql`${mcpConnections.requestCount} + ${entry.count}`,
      })
      .where(eq(mcpConnections.id, connectionId))
      .catch(() => {});
  }, USAGE_FLUSH_MS);
  timer.unref?.();
  pendingUsage.set(connectionId, { count: 1, timer });
}

/**
 * Whether Bento's own MCP server is on for the member a connection acts
 * as, on the permanent `beta-testers` flag.
 *
 * The console hides the section and the management routes answer 404,
 * so a member off the flag cannot create a connection. This is the
 * other half: the tool calls themselves. Without it a token minted
 * while its owner was on the flag would keep serving after they came
 * off it, which is the one direction that matters, since taking access
 * away is the whole point of an allowlist.
 *
 * The answer is cached briefly per connection because it sits on the
 * data path. Evaluating a remote flag on every tools/call would put a
 * PostHog round trip in front of each one, which is the cost
 * recordConnectionUse exists to avoid for writes. A minute is short
 * enough that removing someone takes effect while they are still
 * looking at the screen.
 */
const BETA_TTL_MS = 60_000;
const betaCache = new Map<string, { allowed: boolean; at: number }>();

export async function connectionOwnerIsBetaTester(ctx: AppContext, ownerId: string): Promise<boolean> {
  const now = Date.now();
  const cached = betaCache.get(ownerId);
  if (cached && now - cached.at < BETA_TTL_MS) return cached.allowed;

  // Local mode has one trusted user and no allowlist to be off.
  if (!ctx.featureFlags) return ctx.env.BENTO_MODE !== "multi";
  const [row] = await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, ownerId)).limit(1);
  // Fails closed, like every other flag read here: a server that cannot
  // reach PostHog serves no tools rather than serving them to everyone.
  const allowed = await ctx.featureFlags.isBetaTester(ownerId, { email: row?.email ?? null });
  betaCache.set(ownerId, { allowed, at: now });
  return allowed;
}

/** Drops the cached decisions. For the tests, which flip the flag. */
export function clearBetaCache(): void {
  betaCache.clear();
}
