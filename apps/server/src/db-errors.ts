/**
 * Reading a Postgres error through whatever wrapped it.
 *
 * Drizzle raises its own DrizzleQueryError and hangs the driver's error
 * off `cause`, so `String(err)` is "Failed query: delete from ..." and
 * carries no constraint name at all. Route code that matched on the
 * text was therefore matching on something that had stopped being
 * there, and a refusal that should have read as 409 with a sentence
 * became a 500 with none.
 */

/** Postgres SQLSTATE for a foreign key violation. */
const FOREIGN_KEY_VIOLATION = "23503";

interface PostgresError {
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

/** The driver's error, from anywhere in the cause chain. */
export function postgresError(err: unknown): PostgresError | null {
  let current: unknown = err;
  // Bounded: a cycle in `cause` would otherwise hang the request.
  for (let depth = 0; current && depth < 8; depth += 1) {
    const candidate = current as PostgresError & { cause?: unknown };
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * The constraint a delete or insert ran into, or null when the failure
 * was something else. Callers match on the constraint name, which is
 * stable, rather than on a message, which is not.
 */
export function foreignKeyViolation(err: unknown): string | null {
  const pg = postgresError(err);
  return pg?.code === FOREIGN_KEY_VIOLATION ? (pg.constraint ?? "") : null;
}
