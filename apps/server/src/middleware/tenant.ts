import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "@bento/db";
import type { AppContext } from "../context.js";
import { activeOrg } from "./actor.js";

export const TENANT_DB_KEY = "bentoDb";

/**
 * Runs a request inside a transaction that row-level security applies to.
 *
 * Two things make the policies live: switching to a role without
 * BYPASSRLS, and setting the organization the request acts for. Both are
 * LOCAL, so they revert when the transaction ends and never leak onto a
 * pooled connection.
 *
 * Background workers deliberately do not pass through here. They keep
 * the owner's cross-organization reach, which is what lets one process
 * execute runs and evaluate gates for every tenant.
 *
 * Streams are excluded: they hold their connection for the length of an
 * agent run, which would drain the pool. They query the database twice
 * at setup and then stream from the event bus, so their exposure is a
 * pair of statements guarded by the route's own access check.
 */
export function tenantMiddleware(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    if (ctx.env.BENTO_MODE !== "multi" || isStream(c.req.path)) {
      c.set(TENANT_DB_KEY, ctx.db);
      return next();
    }

    const orgId = activeOrg(c) ?? "";
    await ctx.db.transaction(async (tx) => {
      // Both settings in one statement, so the guard costs a single
      // round trip. set_config rather than SET LOCAL ROLE because this
      // carries a parameter, and Postgres refuses more than one command
      // in a parameterized statement.
      await tx.execute(
        sql`select set_config('role', 'bento_user', true), set_config('bento.org_id', ${orgId}, true)`,
      );
      c.set(TENANT_DB_KEY, tx as unknown as Db);
      await next();
    });
  };
}

/** The database handle for this request: scoped in multi mode. */
export function tenantDb(c: { get: (key: string) => unknown }, ctx: AppContext): Db {
  return (c.get(TENANT_DB_KEY) as Db | undefined) ?? ctx.db;
}

function isStream(path: string): boolean {
  return path.endsWith("/events");
}
