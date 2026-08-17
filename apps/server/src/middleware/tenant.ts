import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "@bento/db";
import type { AppContext } from "../context.js";
import { activeOrg } from "./actor.js";

export const TENANT_DB_KEY = "bentoDb";
const AFTER_COMMIT_KEY = "bentoAfterCommit";

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
    const deferred: (() => Promise<void>)[] = [];
    c.set(AFTER_COMMIT_KEY, deferred);

    if (ctx.env.BENTO_MODE !== "multi" || isStream(c.req.path)) {
      c.set(TENANT_DB_KEY, ctx.db);
      await next();
      await runDeferred(deferred);
      return;
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
    // Only now are the handler's rows visible to anyone else.
    await runDeferred(deferred);
  };
}

/**
 * Defers work until the request's rows are committed and visible to
 * other connections.
 *
 * Queueing a job is the case this exists for. pg-boss writes on its own
 * connection and commits immediately, so a job sent from inside the
 * tenant transaction can be claimed by a worker before the row it names
 * exists anywhere that worker can see it. The worker then finds nothing,
 * and a job that finds nothing is indistinguishable from a job whose
 * subject was deleted: it acks, and the work is silently dropped.
 *
 * A task that throws is logged and the rest still run. The transaction
 * is already committed by then, so there is nothing left to undo, and
 * the response has been decided.
 */
export function deferAfterCommit(
  c: { get: (key: string) => unknown },
  task: () => Promise<void>,
): void {
  const deferred = c.get(AFTER_COMMIT_KEY) as (() => Promise<void>)[] | undefined;
  if (!deferred) {
    // No tenant middleware in this chain (tests mounting a route bare).
    void task().catch((err) => console.error("deferred task failed:", err));
    return;
  }
  deferred.push(task);
}

async function runDeferred(tasks: (() => Promise<void>)[]): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      console.error("deferred task failed:", err);
    }
  }
}

/** The database handle for this request: scoped in multi mode. */
export function tenantDb(c: { get: (key: string) => unknown }, ctx: AppContext): Db {
  return (c.get(TENANT_DB_KEY) as Db | undefined) ?? ctx.db;
}

function isStream(path: string): boolean {
  return path.endsWith("/events");
}
