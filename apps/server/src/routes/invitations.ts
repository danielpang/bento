import { Hono } from "hono";
import { and, eq, gt } from "drizzle-orm";
import { invitation, organization, user } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * The invitation link's pre-session read.
 *
 * Answers, for a live invitation id only: who was invited, which team,
 * and whether that address already has an account. The id is the
 * capability: it travels only in the invitation email, so presenting it
 * entitles the visitor to the invitee's own facts and nothing more.
 * userExists is what lets the page open on sign up for someone new
 * instead of a sign-in form they cannot use.
 *
 * Deliberately narrower than better-auth's get-invitation, which
 * requires a session this visitor does not have yet. An unknown,
 * spent, or expired id answers 404, indistinguishable from none, and
 * accepting still goes through better-auth, which checks the session's
 * email against the invitation.
 *
 * The disclosure is a considered trade: an organization owner can mint
 * an invitation for any address and read userExists from it, which is
 * the account-existence question the sign-in form refuses to answer.
 * The brakes are that minting goes through invite-member, which is
 * rate limited and emails the address it probes, and that this route
 * meters repeat lookups below. Tighten there, not by weakening the
 * page this exists for.
 */
export function invitationPreviewRoutes(ctx: AppContext) {
  /**
   * A small brake on lookups: one budget per invitation id, and one
   * per caller wherever a proxy in front of this server names them.
   *
   * In memory and per instance on purpose: the query behind it is a
   * single indexed probe, so this only has to stop tight loops, not
   * survive restarts or coordinate across machines the way the auth
   * limiter does. Legitimate use is a handful of page loads.
   *
   * Both budgets are needed. Per id alone cannot meter a sweep, since
   * a caller who never repeats an id never repeats a key, so every
   * probe took the fresh-window branch and ran its own join. The
   * caller budget is what bounds that, and it is also what bounds how
   * far this map can grow.
   */
  const hits = new Map<string, { windowStart: number; count: number }>();
  const WINDOW_MS = 60_000;
  const MAX_PER_ID = 60;
  const MAX_PER_CLIENT = 120;

  /**
   * Only the windows that have already rolled over.
   *
   * This used to clear the map outright, which meant a flood of junk
   * ids wiped the counters of the ids actually being metered: an
   * attacker held at the limit on one id could seed enough keys to
   * trip the clear and resume at full rate, over and over.
   */
  function sweepExpired(now: number): void {
    for (const [key, hit] of hits) {
      if (now - hit.windowStart > WINDOW_MS) hits.delete(key);
    }
  }

  function allow(key: string, max: number): boolean {
    const now = Date.now();
    const hit = hits.get(key);
    if (!hit || now - hit.windowStart > WINDOW_MS) {
      if (hits.size > 10_000) sweepExpired(now);
      hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    hit.count += 1;
    return hit.count <= max;
  }

  return new Hono().get("/", async (c) => {
    // The body names a personal address and the URL is the capability,
    // so neither belongs in a shared cache.
    c.header("cache-control", "no-store");
    const id = c.req.query("id");
    // Bounded rather than exact, so this does not have to track how
    // better-auth mints ids: an id that could not exist is refused for
    // the cost of a regex instead of a three table join.
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return c.json({ error: "not found" }, 404);
    // The first hop of the forwarded chain, which is what the proxy in
    // front of a hosted deployment writes. Only metered when one is
    // present: a deployment with no proxy has no caller to tell apart,
    // and one shared bucket would lock every visitor out together.
    const client = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (client && !allow(`client:${client}`, MAX_PER_CLIENT)) {
      return c.json({ error: "too many requests" }, 429);
    }
    if (!allow(`id:${id}`, MAX_PER_ID)) return c.json({ error: "too many requests" }, 429);
    // One indexed query. better-auth lowercases both user.email and
    // invitation.email on write, so plain equality joins on the unique
    // index; re-folding case here would throw that index away. The
    // liveness rules (pending, unexpired) live in the WHERE so an
    // expired invitation is indistinguishable from none, and so the
    // date comparison is type checked against the column.
    const [row] = await ctx.db
      .select({
        email: invitation.email,
        organizationName: organization.name,
        userId: user.id,
      })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .leftJoin(user, eq(user.email, invitation.email))
      .where(and(eq(invitation.id, id), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      email: row.email,
      organizationName: row.organizationName,
      userExists: row.userId !== null,
    });
  });
}
