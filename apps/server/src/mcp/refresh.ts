import { eq, sql } from "drizzle-orm";
import { mcpCredentials, mcpServers } from "@bento/db";
import type { AppContext } from "../context.js";
import { OAuthError, refreshTokens } from "./oauth.js";
import { safeFetchPolicy } from "./safe-fetch.js";

/**
 * Refreshes one OAuth credential, serialized across processes.
 *
 * Bento runs more than one server process, so an in-memory single
 * flight is not enough: two instances refreshing the same credential
 * would each rotate the refresh token, and the loser would persist a
 * stale one or trip the provider's reuse detection, silently killing a
 * healthy credential. A Postgres advisory lock keyed on the credential
 * id makes the refresh happen once; whoever loses the race re-reads the
 * row and finds the fresh token already there.
 *
 * Returns the current access token to use, or null when the credential
 * cannot be refreshed (no refresh token, or the grant is dead). The
 * caller passes a 401 through in that case.
 */
export async function refreshCredential(
  ctx: AppContext,
  server: typeof mcpServers.$inferSelect,
  credentialId: string,
): Promise<string | null> {
  // Captured as locals so the narrowing survives into the closure below.
  const tokenEndpoint = server.tokenEndpoint;
  const clientId = server.clientId;
  if (!tokenEndpoint || !clientId) return null;

  return ctx.db.transaction(async (tx) => {
    // A transaction-scoped advisory lock: released on commit, and it
    // does not block reads of the row, only a second refresh of it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${credentialId}, 0))`);

    const [row] = await tx.select().from(mcpCredentials).where(eq(mcpCredentials.id, credentialId)).limit(1);
    if (!row || row.kind !== "oauth" || !row.encryptedRefreshToken) return null;

    // Another instance refreshed while we waited for the lock: the row
    // now has an unexpired access token, so use it and skip the call.
    if (row.expiresAt && row.expiresAt.getTime() > Date.now() + 5_000) {
      try {
        return ctx.secretBox.decrypt(row.encryptedSecret);
      } catch {
        return null;
      }
    }

    // The credential must still belong to the endpoints it was minted
    // against, or a repointed server could send the refresh token
    // somewhere new.
    if (row.tokenEndpointOrigin && row.tokenEndpointOrigin !== new URL(tokenEndpoint).origin) {
      return null;
    }

    let refreshToken: string;
    let clientSecret: string | null = null;
    try {
      refreshToken = ctx.secretBox.decrypt(row.encryptedRefreshToken);
      if (server.encryptedClientSecret) clientSecret = ctx.secretBox.decrypt(server.encryptedClientSecret);
    } catch {
      return null;
    }

    let tokens;
    try {
      tokens = await refreshTokens(
        {
          tokenEndpoint,
          clientId,
          clientSecret,
          refreshToken,
          resource: server.resource ?? server.url,
        },
        safeFetchPolicy(ctx.env),
      );
    } catch (err) {
      // A dead grant is honest to surface: the run's tool 401s and the
      // member reconnects. A transient failure also passes the 401
      // through; the next request tries again.
      if (err instanceof OAuthError) return null;
      throw err;
    }

    await tx
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
  });
}
