import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { mcpRunGrants } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * Run-scoped gateway tokens: the only credential a sandbox ever holds.
 *
 * The raw token exists in exactly two places, both outside this
 * database: the harness config files written into the run's sandbox,
 * and the Authorization header of gateway requests. The row keeps its
 * sha256, so a database read yields nothing replayable. Revocation on
 * the run's terminal paths is what makes exfiltrating one worth so
 * little: the token outlives its run only by the sweep interval.
 */

const TOKEN_PREFIX = "bmg_";

export function hashGrantToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mints (or re-mints) the grant for a run. An upsert on run_id, never a
 * bare insert: executeRun legitimately runs more than once for the same
 * run after a crash or a pg-boss re-queue, and the second attempt must
 * replace the token rather than die on the unique index. The old token
 * dies naturally because only the new hash matches.
 */
export async function mintRunGrant(
  ctx: AppContext,
  input: {
    runId: string;
    organizationId: string | null;
    actingUserId: string | null;
    serverIds: string[];
    /**
     * The swarm this run works for, copied onto the grant at mint.
     *
     * Bento's own swarm tools authorize per call against the run, and
     * this is the second half of that check: a grant that names a swarm
     * cannot be used on a run that has since been repointed at another
     * one. Null for a card's run, which has no swarm.
     */
    swarmId?: string | null;
    ttlMs: number;
  },
): Promise<string> {
  const raw = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlMs);
  await ctx.db
    .insert(mcpRunGrants)
    .values({
      runId: input.runId,
      organizationId: input.organizationId,
      actingUserId: input.actingUserId,
      tokenHash: hashGrantToken(raw),
      serverIds: input.serverIds,
      swarmId: input.swarmId ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: mcpRunGrants.runId,
      set: {
        tokenHash: hashGrantToken(raw),
        actingUserId: input.actingUserId,
        serverIds: input.serverIds,
        swarmId: input.swarmId ?? null,
        expiresAt,
        revokedAt: null,
      },
    });
  return raw;
}

/** Ends the grant with its run. Behind the terminal paths' CAS, so once. */
export async function revokeRunGrant(ctx: AppContext, runId: string): Promise<void> {
  try {
    await ctx.db
      .update(mcpRunGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpRunGrants.runId, runId));
  } catch (err) {
    // Revocation must never take the run's own close with it; the TTL
    // is the backstop.
    console.error(`could not revoke the MCP grant for run ${runId}:`, err);
  }
}

/**
 * Reattach after a restart: the sandbox still holds the config files
 * with the original token, so the row is extended rather than
 * re-minted. A grant revoked or expired during the outage stays dead;
 * the run's tools answer 404 for the remainder, which is honest.
 */
export async function extendRunGrant(ctx: AppContext, runId: string, ttlMs: number): Promise<void> {
  await ctx.db
    .update(mcpRunGrants)
    .set({ expiresAt: new Date(Date.now() + ttlMs) })
    .where(and(eq(mcpRunGrants.runId, runId), sql`${mcpRunGrants.revokedAt} is null`));
}

/** True when the run still has a grant row, whatever its state. */
export async function runGrantExists(ctx: AppContext, runId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: mcpRunGrants.id })
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.runId, runId))
    .limit(1);
  return Boolean(row);
}

/**
 * Whether a run actually attached MCP servers: a grant that is not
 * revoked and pins at least one server. The resume path keys the MCP
 * flags off this, so a run that minted no grant (nothing attached) or
 * had its grant revoked (a failed config write) does not gain
 * --mcp-config on reattach that its first life never had.
 */
export async function runHasActiveMcp(ctx: AppContext, runId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ serverIds: mcpRunGrants.serverIds, revokedAt: mcpRunGrants.revokedAt })
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.runId, runId))
    .limit(1);
  return Boolean(row && !row.revokedAt && Array.isArray(row.serverIds) && row.serverIds.length > 0);
}

/** Sweep: expired rows are audit noise after a week. */
export async function sweepExpiredGrants(ctx: AppContext): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  await ctx.db.delete(mcpRunGrants).where(lt(mcpRunGrants.expiresAt, cutoff));
}

export interface ResolvedGrant {
  id: string;
  runId: string;
  organizationId: string | null;
  actingUserId: string | null;
  serverIds: string[];
  /** The swarm this grant was minted for; null for a card's run. */
  swarmId: string | null;
}

/**
 * The gateway's authentication: one indexed read by token hash. Every
 * refusal is the same null, so a probe cannot tell missing from
 * revoked from expired.
 */
export async function resolveGrant(ctx: AppContext, rawToken: string): Promise<ResolvedGrant | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await ctx.db
    .select()
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.tokenHash, hashGrantToken(rawToken)))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return {
    id: row.id,
    runId: row.runId,
    organizationId: row.organizationId,
    actingUserId: row.actingUserId,
    serverIds: row.serverIds,
    swarmId: row.swarmId,
  };
}

/**
 * Usage is visible without costing a write per request: the counter
 * flushes at most every few seconds per grant.
 */
const USAGE_FLUSH_MS = 5_000;
const pendingUsage = new Map<string, { count: number; timer: NodeJS.Timeout }>();

export function recordGrantUse(ctx: AppContext, grantId: string): void {
  const pending = pendingUsage.get(grantId);
  if (pending) {
    pending.count += 1;
    return;
  }
  const timer = setTimeout(() => {
    const entry = pendingUsage.get(grantId);
    pendingUsage.delete(grantId);
    if (!entry) return;
    void ctx.db
      .update(mcpRunGrants)
      .set({
        lastUsedAt: new Date(),
        requestCount: sql`${mcpRunGrants.requestCount} + ${entry.count}`,
      })
      .where(and(eq(mcpRunGrants.id, grantId), isNotNull(mcpRunGrants.id)))
      .catch(() => {});
  }, USAGE_FLUSH_MS);
  timer.unref?.();
  pendingUsage.set(grantId, { count: 1, timer });
}
