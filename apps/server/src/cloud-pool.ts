import { createPool } from "@bento/db";

/**
 * How many connections the billing module may hold at once.
 *
 * A plan check is one indexed read, and the client goes back as soon
 * as that read returns. Four covers a burst of those reads. It stays
 * far under the app pool (16 on the web process) because this pool's
 * only job is to keep a plan check from waiting on the request that
 * is waiting on it.
 */
export const CLOUD_POOL_MAX = 4;

/**
 * The pool handed to `BENTO_CLOUD_MODULE`.
 *
 * `canUseSwarms` (and the other entitlement checks) read
 * `organization_plans` through the database this module was given.
 * Routes ask that question from inside the request's tenant
 * transaction, which already holds a client of the app pool. A lookup
 * on that same pool checks out a second client. The web process's app
 * pool is `poolMaxForRuns(0)`, 16. A burst of swarm and run reads,
 * each holding one client and waiting for another, takes all 16.
 * Nothing releases a client until its lookup finishes, and the lookup
 * cannot start until a client is free, so every waiter sits until
 * `connectionTimeoutMillis`. The plan query, the next request's
 * transaction, and session resolution then fail together.
 *
 * A separate pool breaks that cycle. The lookup still runs as this
 * pool's own role, not as `bento_user`: the request transaction has
 * already set the role, and `organization_plans` is not one of this
 * server's tenant tables.
 */
export function createCloudPool(databaseUrl: string): ReturnType<typeof createPool> {
  return createPool(databaseUrl, { max: CLOUD_POOL_MAX });
}
