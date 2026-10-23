import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { agentRuns, mcpRunGrants } from "@bento/db";
import type { AppContext } from "../context.js";
import { ACTIVE_RUN_STATUSES } from "../orchestrator/start-run.js";

/**
 * Run-scoped gateway tokens: the only credential a sandbox ever holds.
 *
 * One token per run serves both doors into Bento: the MCP gateway, for
 * the servers the grant pins, and the model proxy, for the provider
 * keys it names (model_credentials), which in multi mode the sandbox
 * holds this token in place of.
 *
 * The raw token exists outside this database: the harness config
 * files written into the run's sandbox (or, for fx, the
 * BENTO_MCP_GRANT process environment that file names, because fx
 * rejects a literal Authorization header), the provider key variables
 * of a proxied run's environment, and the headers of gateway and
 * proxy requests. The row keeps its sha256, so a
 * database read yields nothing replayable. A token serves only while
 * its run is queued, starting or running (resolveGrant reads the run's
 * status in the same query), so it dies the moment its run ends by any
 * path, including the ones that close a run with a bare update and
 * never call revokeRunGrant. Revocation on the terminal paths is the
 * record of that, and the TTL the backstop.
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
     * The stored secrets the model proxy may use for this run: the keys
     * the sandbox holds this token in place of, and a saved base URL
     * the run would have used. Empty when nothing is proxied.
     */
    modelCredentials?: string[];
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
      modelCredentials: input.modelCredentials ?? [],
      swarmId: input.swarmId ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: mcpRunGrants.runId,
      set: {
        tokenHash: hashGrantToken(raw),
        actingUserId: input.actingUserId,
        serverIds: input.serverIds,
        modelCredentials: input.modelCredentials ?? [],
        swarmId: input.swarmId ?? null,
        expiresAt,
        revokedAt: null,
        // A new life of the run: a proxy failure in the last one is
        // not this one's.
        proxyFailedAt: null,
      },
    });
  return raw;
}

/**
 * Pins the MCP servers a run attached onto the grant it already holds.
 *
 * A run whose model keys are proxied minted its grant before its MCP
 * servers were known, and its sandbox already carries that token in
 * the provider key variables. Minting again would replace the token
 * those variables hold, so the servers join the existing row instead.
 * An empty list detaches every server and leaves the proxy working,
 * which is what a failed config write needs: revoking would take the
 * model with it.
 */
export async function setRunGrantServers(ctx: AppContext, runId: string, serverIds: string[]): Promise<void> {
  await ctx.db.update(mcpRunGrants).set({ serverIds }).where(eq(mcpRunGrants.runId, runId));
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
 * What a run's live grant is for: the MCP servers it pins and the
 * provider keys the model proxy carries. Null when the run has no grant
 * or it was revoked. The reattach path extends a grant that serves
 * either, because the sandbox holds its token for both.
 */
export async function runGrantUses(
  ctx: AppContext,
  runId: string,
): Promise<{ serverIds: string[]; modelCredentials: string[] } | null> {
  const [row] = await ctx.db
    .select({
      serverIds: mcpRunGrants.serverIds,
      modelCredentials: mcpRunGrants.modelCredentials,
      revokedAt: mcpRunGrants.revokedAt,
    })
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.runId, runId))
    .limit(1);
  if (!row || row.revokedAt) return null;
  return {
    serverIds: Array.isArray(row.serverIds) ? row.serverIds : [],
    modelCredentials: row.modelCredentials ?? [],
  };
}

/**
 * Records that the model proxy itself failed one of this grant's
 * requests (Bento's own failure: a lookup, a decryption, its own code,
 * never a provider it could not reach). Best effort: the request is
 * already being answered with the proxy's own error, and a stamp that
 * cannot be written must not turn that into something else.
 */
export async function markModelProxyFailed(ctx: AppContext, grantId: string): Promise<void> {
  try {
    await ctx.db.update(mcpRunGrants).set({ proxyFailedAt: new Date() }).where(eq(mcpRunGrants.id, grantId));
  } catch (err) {
    console.error(`could not record a model proxy failure on grant ${grantId}:`, err);
  }
}

/**
 * Clears the failure stamp once the proxy has carried a request of this
 * grant's to the provider again. A stamp means the run's model calls
 * were failing on Bento when it ended; one early failure the agent
 * retried past says nothing about why the run later failed, and must
 * not waive the bill for a failure of the work's own. Only a stamp
 * older than the request that succeeded is cleared, so a failure that
 * landed while it was in flight stands. Best effort, like the stamp.
 */
export async function clearModelProxyFailure(ctx: AppContext, grantId: string, before: Date): Promise<void> {
  try {
    await ctx.db
      .update(mcpRunGrants)
      .set({ proxyFailedAt: null })
      .where(and(eq(mcpRunGrants.id, grantId), lt(mcpRunGrants.proxyFailedAt, before)));
  } catch (err) {
    console.error(`could not clear the model proxy failure on grant ${grantId}:`, err);
  }
}

/**
 * Whether the model proxy's last word on this run's model calls was a
 * failure of its own. A run that then failed failed on Bento, whatever
 * the agent made of the error it was handed, so it is not billed. Read
 * from the grant, which records what the proxy did, never from the
 * run's error text.
 */
export async function runHadModelProxyFailure(ctx: AppContext, runId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ proxyFailedAt: mcpRunGrants.proxyFailedAt })
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.runId, runId))
    .limit(1);
  return Boolean(row?.proxyFailedAt);
}

/**
 * Whether a run actually attached MCP servers: a grant that is not
 * revoked and pins at least one server. The resume path keys the MCP
 * flags off this, so a run that minted no grant (nothing attached) or
 * had its grant revoked (a failed config write) does not gain
 * --mcp-config on reattach that its first life never had.
 */
export async function runHasActiveMcp(ctx: AppContext, runId: string): Promise<boolean> {
  return (await runGrantServerIds(ctx, runId)).length > 0;
}

/**
 * Which servers a live grant pins, or nothing.
 *
 * The resume path needs more than a yes or no: which servers were
 * attached decides not only the MCP flags but what the run's prompt
 * claimed it could do. A grant minted before Bento's own tools existed
 * pins only real servers, and a resumed run of it must not be told it
 * can split its card.
 */
export async function runGrantServerIds(ctx: AppContext, runId: string): Promise<string[]> {
  const [row] = await ctx.db
    .select({ serverIds: mcpRunGrants.serverIds, revokedAt: mcpRunGrants.revokedAt })
    .from(mcpRunGrants)
    .where(eq(mcpRunGrants.runId, runId))
    .limit(1);
  if (!row || row.revokedAt || !Array.isArray(row.serverIds)) return [];
  return row.serverIds;
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
  /** The stored secrets the model proxy may use for this run. */
  modelCredentials: string[];
  /** The swarm this grant was minted for; null for a card's run. */
  swarmId: string | null;
  /** When the grant stops serving, whatever its run does. */
  expiresAt: Date;
  /** Whether the model proxy's failure stamp is set (see markModelProxyFailed). */
  proxyFailed: boolean;
}

/**
 * The gateway's and the model proxy's authentication: one indexed read
 * by token hash, joined to the run. Every refusal is the same null, so
 * a probe cannot tell missing from revoked from expired from a run
 * that is over.
 *
 * The run's status is read in the same query, and a grant serves only
 * while its run is queued, starting or running. Several paths close a
 * run with a bare update (a cancel route, a swarm stopping, a stage
 * agent switched) and never revoke its grant; this one check covers
 * every one of them, and any written later. A run adopted or reattached
 * after a restart is still running, so its token keeps working.
 */
export async function resolveGrant(ctx: AppContext, rawToken: string): Promise<ResolvedGrant | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const [found] = await ctx.db
    .select({ grant: mcpRunGrants })
    .from(mcpRunGrants)
    .innerJoin(agentRuns, eq(agentRuns.id, mcpRunGrants.runId))
    .where(and(eq(mcpRunGrants.tokenHash, hashGrantToken(rawToken)), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  const row = found?.grant;
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return {
    id: row.id,
    runId: row.runId,
    organizationId: row.organizationId,
    actingUserId: row.actingUserId,
    serverIds: row.serverIds,
    modelCredentials: row.modelCredentials ?? [],
    swarmId: row.swarmId,
    expiresAt: row.expiresAt,
    proxyFailed: row.proxyFailedAt !== null,
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
