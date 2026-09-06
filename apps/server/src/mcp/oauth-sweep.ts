import { and, lt, notInArray, sql } from "drizzle-orm";
import { mcpConnections, mcpOAuthClients, mcpOAuthCodes, mcpOAuthRequests } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * Reclaims the rows the OAuth flow leaves behind when nobody finishes.
 *
 * Every happy path deletes its own row: an exchanged code, an approved
 * or denied request. The unhappy paths are the common ones, and none of
 * them deleted anything. A member who opens the consent page and closes
 * the tab leaves a request row forever, and `/register` is an
 * unauthenticated insert, so anyone who can reach the server could grow
 * the client table without bound. Both tables carry `expires_at` with
 * an index and nothing ever read them.
 *
 * The grace period is generous because none of this is urgent: a code
 * is dead the moment it expires, and these deletes only reclaim space.
 */

/** Expired an hour ago is expired. Nothing here has audit value. */
const GRACE_MS = 60 * 60_000;

/**
 * A registered client with no connection is worth keeping for a while:
 * a host may register, send the member to consent, and have them
 * approve the next morning. A month later it is abandoned.
 */
const UNUSED_CLIENT_MS = 30 * 24 * 60 * 60_000;

export async function sweepExpiredOAuth(ctx: AppContext): Promise<void> {
  const cutoff = new Date(Date.now() - GRACE_MS);
  await ctx.db.delete(mcpOAuthCodes).where(lt(mcpOAuthCodes.expiresAt, cutoff));
  await ctx.db.delete(mcpOAuthRequests).where(lt(mcpOAuthRequests.expiresAt, cutoff));

  /**
   * Clients only go once nothing points at them. A live connection
   * names its client on every refresh, so the subquery is the whole
   * safety check: registrations that never became a connection, and
   * ones whose connection has since been disconnected, are what is
   * left. A host that comes back simply registers again.
   */
  const used = ctx.db
    .select({ clientId: sql<string>`${mcpConnections.oauthClientId}` })
    .from(mcpConnections)
    .where(sql`${mcpConnections.oauthClientId} is not null`);
  await ctx.db
    .delete(mcpOAuthClients)
    .where(
      and(
        lt(mcpOAuthClients.createdAt, new Date(Date.now() - UNUSED_CLIENT_MS)),
        notInArray(mcpOAuthClients.clientId, used),
      ),
    );
}

/** Exported for the tests, which need to age a row past the grace. */
export const OAUTH_SWEEP_GRACE_MS = GRACE_MS;
export const OAUTH_SWEEP_UNUSED_CLIENT_MS = UNUSED_CLIENT_MS;
