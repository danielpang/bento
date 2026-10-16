import { and, eq, lt, ne, sql } from "drizzle-orm";
import { sandboxOperations } from "@bento/db";
import type { SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";

type Operation = typeof sandboxOperations.$inferInsert;
export const OPERATION_STALE_MS = 5 * 60_000;

/** A durable intent precedes the side effect. A timeout is unknown, never proof of failure. */
export async function sandboxOperation<T>(
  ctx: AppContext,
  spec: Pick<Operation, "projectId" | "workspaceKey" | "provider" | "action"> & { handle?: SandboxHandle },
  work: (recordHandle: (handle: SandboxHandle) => Promise<void>) => Promise<T>,
): Promise<T> {
  const clean = (h: SandboxHandle) => ({ externalId: h.externalId, provider: h.provider, workdir: h.workdir,
    ...(h.imageRef ? { imageRef: h.imageRef } : {}) });
  const [op] = await ctx.db.insert(sandboxOperations).values({ ...spec, handle: spec.handle ? clean(spec.handle) : null }).returning();
  if (!op) throw new Error("Could not record sandbox operation");
  const where = and(eq(sandboxOperations.id, op.id), eq(sandboxOperations.state, "executing"));
  const timer = setInterval(() => {
    void ctx.db.update(sandboxOperations).set({ heartbeatAt: sql`now()` }).where(where)
      .catch((err) => console.warn("Could not renew sandbox operation", op.id, err));
  }, 30_000);
  timer.unref();
  try {
    const result = await work(async (handle) => {
      await ctx.db.update(sandboxOperations).set({ handle: clean(handle), updatedAt: sql`now()` }).where(where);
    });
    await ctx.db.update(sandboxOperations).set({ state: "succeeded", updatedAt: sql`now()` }).where(eq(sandboxOperations.id, op.id));
    return result;
  } catch (error) {
    await ctx.db.update(sandboxOperations).set({ state: "unknown", updatedAt: sql`now()`,
      errorClass: error instanceof Error ? error.name : "UnknownError" }).where(eq(sandboxOperations.id, op.id))
      .catch((err) => console.warn("Could not record uncertain sandbox operation", op.id, err));
    throw error;
  } finally {
    clearInterval(timer);
  }
}

/** Observation only: recovery must never replay an ambiguous destructive request. */
export async function reconcileSandboxOperations(ctx: AppContext): Promise<void> {
  const rows = await ctx.db.select().from(sandboxOperations).where(and(
    ne(sandboxOperations.state, "succeeded"),
    lt(sandboxOperations.heartbeatAt, sql`now() - interval '5 minutes'`),
  )).orderBy(sandboxOperations.heartbeatAt).limit(100);
  for (const op of rows) {
    let state: "succeeded" | "unknown" = "unknown";
    try {
      const driver = ctx.drivers.get(op.provider);
      if (driver && op.handle) {
        if (op.action === "destroy" && driver.exists && !(await driver.exists(op.handle))) state = "succeeded";
        // A live machine proves a wake, but not a completed checkout or a durable snapshot.
        if (op.action === "wake" && driver.running && await driver.running(op.handle)) state = "succeeded";
      }
      await ctx.db.update(sandboxOperations).set({ state, heartbeatAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(sandboxOperations.id, op.id), eq(sandboxOperations.state, op.state),
          lt(sandboxOperations.heartbeatAt, sql`now() - interval '5 minutes'`)));
    } catch (err) {
      console.warn("Could not reconcile sandbox operation", op.id, err);
    }
  }
}
