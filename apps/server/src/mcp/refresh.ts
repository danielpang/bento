import { eq, sql } from "drizzle-orm";
import { mcpCredentials, mcpServers } from "@bento/db";
import type { AppContext } from "../context.js";
import { OAuthError, refreshTokens } from "./oauth.js";
import { safeFetchPolicy } from "./safe-fetch.js";

/**
 * Refreshes one OAuth credential, once, without draining the pool.
 *
 * Two layers of single flight, because a shared org token expires for
 * every run in the org at the same instant:
 *
 * 1. In process, an inflight map collapses a burst of concurrent 401s
 *    for the same credential into one refresh; the rest await it. This
 *    is what keeps a busy org's simultaneous 401s from each opening a
 *    database connection.
 * 2. Across processes, a non-blocking pg_try_advisory_xact_lock elects
 *    one refresher. A process that does not win the lock does not block
 *    a pooled connection waiting on it: it returns its transaction at
 *    once, waits briefly, and re-reads the row, where the winner will
 *    have written the fresh token.
 *
 * Only the elected refresher holds a connection across the token
 * endpoint call, and the map bounds that to one per credential per
 * process. The blocking pg_advisory_xact_lock this replaced would pin a
 * connection per waiter for the whole HTTP round trip.
 *
 * Returns the access token to use, or null when the credential cannot
 * be refreshed. The caller passes a 401 through in that case.
 */

const inflight = new Map<string, Promise<string | null>>();

export function refreshCredential(
  ctx: AppContext,
  server: typeof mcpServers.$inferSelect,
  credentialId: string,
  /** The access token that just failed or expired; a stored token that
   * differs from it means another refresher already ran. */
  staleToken: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const existing = inflight.get(credentialId);
  if (existing) return existing;
  const p = doRefresh(ctx, server, credentialId, staleToken, signal).finally(() => {
    inflight.delete(credentialId);
  });
  inflight.set(credentialId, p);
  return p;
}

async function doRefresh(
  ctx: AppContext,
  server: typeof mcpServers.$inferSelect,
  credentialId: string,
  staleToken: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const tokenEndpoint = server.tokenEndpoint;
  const clientId = server.clientId;
  if (!tokenEndpoint || !clientId) return null;

  // One short transaction: win the lock (non-blocking) and read the row,
  // or lose it and get nothing. The connection is released on return,
  // before any network call.
  const claim = await ctx.db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${credentialId}, 0)) as ok`,
    );
    const won = ((locked as unknown as { rows?: { ok: boolean }[] }).rows?.[0]?.ok) === true;
    const [row] = await tx.select().from(mcpCredentials).where(eq(mcpCredentials.id, credentialId)).limit(1);
    return { won, row };
  });

  // Another process is refreshing. Wait briefly, then use whatever it
  // wrote. Never blocks a held connection on the lock.
  if (!claim.won) {
    await delay(400, signal);
    const [row] = await ctx.db.select().from(mcpCredentials).where(eq(mcpCredentials.id, credentialId)).limit(1);
    return decryptAccess(ctx, row);
  }

  const row = claim.row;
  if (!row || row.kind !== "oauth" || !row.encryptedRefreshToken) return null;
  // The stored token already differs from the one that failed: another
  // refresher won and wrote a new one while we waited for the lock. Use
  // it rather than refreshing again (which would rotate the refresh
  // token a second time). Keyed off the token itself, not the expiry,
  // because a token can be rejected before our clock says it expired.
  const current = decryptAccess(ctx, row);
  if (current && current !== staleToken) return current;
  // The credential must still belong to the endpoints it was minted
  // against, or a repointed server could send the refresh token
  // somewhere new.
  if (row.tokenEndpointOrigin && row.tokenEndpointOrigin !== new URL(tokenEndpoint).origin) return null;

  let refreshToken: string;
  let clientSecret: string | null = null;
  try {
    refreshToken = ctx.secretBox.decrypt(row.encryptedRefreshToken);
    if (server.encryptedClientSecret) clientSecret = ctx.secretBox.decrypt(server.encryptedClientSecret);
  } catch {
    return null;
  }

  // The network call happens with no database connection held.
  let tokens;
  try {
    tokens = await refreshTokens(
      { tokenEndpoint, clientId, clientSecret, refreshToken, resource: server.resource ?? server.url },
      safeFetchPolicy(ctx.env),
      signal,
    );
  } catch (err) {
    // A dead grant is honest to surface: the run's tool 401s and the
    // member reconnects. A transient failure also passes the 401
    // through; the next request tries again.
    if (err instanceof OAuthError) return null;
    throw err;
  }

  await ctx.db
    .update(mcpCredentials)
    .set({
      encryptedSecret: ctx.secretBox.encrypt(tokens.accessToken),
      // Keep the old refresh token when the provider did not rotate it.
      encryptedRefreshToken: tokens.refreshToken
        ? ctx.secretBox.encrypt(tokens.refreshToken)
        : row.encryptedRefreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? row.scope,
      updatedAt: new Date(),
    })
    .where(eq(mcpCredentials.id, credentialId));
  return tokens.accessToken;
}

function decryptAccess(ctx: AppContext, row: typeof mcpCredentials.$inferSelect | undefined): string | null {
  if (!row) return null;
  try {
    return ctx.secretBox.decrypt(row.encryptedSecret);
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
