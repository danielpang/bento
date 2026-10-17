import { and, eq, lt, ne, sql } from "drizzle-orm";
import { sandboxOperations } from "@bento/db";
import type { SandboxHandle } from "@bento/sandbox";
import { captureJobErrors } from "../analytics.js";
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

export const SANDBOX_RECONCILE_QUEUE = "sandbox.reconcile";
const RECONCILE_LIMIT = 10;
const LOOKUP_TIMEOUT_MS = 2_000;

/** Register independent housekeeping; never await provider calls during startup. */
export async function registerSandboxOperationReconciliation(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue(SANDBOX_RECONCILE_QUEUE, { name: SANDBOX_RECONCILE_QUEUE, policy: "short" });
  await ctx.boss.work(SANDBOX_RECONCILE_QUEUE, captureJobErrors(ctx.analytics, SANDBOX_RECONCILE_QUEUE, async () => {
    if (!ctx.draining) await reconcileSandboxOperations(ctx);
  }));
  await ctx.boss.schedule(SANDBOX_RECONCILE_QUEUE, "*/5 * * * *", {}, { singletonKey: SANDBOX_RECONCILE_QUEUE });
  await ctx.boss.send(SANDBOX_RECONCILE_QUEUE, {}, { singletonKey: SANDBOX_RECONCILE_QUEUE });
}

/** Observation only: recovery must never replay an ambiguous destructive request. */
export async function reconcileSandboxOperations(ctx: AppContext, options: { lookupTimeoutMs?: number } = {}): Promise<void> {
  const stale = sql`now() - interval '5 minutes'`;
  const rows = await ctx.db.select().from(sandboxOperations).where(and(
    ne(sandboxOperations.state, "succeeded"), lt(sandboxOperations.heartbeatAt, stale),
  )).orderBy(sandboxOperations.heartbeatAt).limit(RECONCILE_LIMIT);
  for (const op of rows) {
    // Claim before calling a provider. Failures and timeouts must back off too,
    // and another server must not inspect the same receipt concurrently.
    const [claimed] = await ctx.db.update(sandboxOperations).set({ heartbeatAt: sql`now()` })
      .where(and(eq(sandboxOperations.id, op.id), eq(sandboxOperations.state, op.state),
        lt(sandboxOperations.heartbeatAt, stale))).returning({ id: sandboxOperations.id });
    if (!claimed) continue;
    let state: "succeeded" | "unknown" = "unknown";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observe = async () => {
        const driver = ctx.drivers.get(op.provider);
        if (driver && op.handle) {
          if (op.action === "destroy" && driver.exists && !(await driver.exists(op.handle))) return "succeeded" as const;
          if (op.action === "wake" && driver.running && await driver.running(op.handle)) return "succeeded" as const;
        }
        return "unknown" as const;
      };
      state = await Promise.race([observe(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox reconciliation lookup timed out")), options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      })]);
    } catch (err) {
      console.warn("Could not reconcile sandbox operation", op.id, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A late provider response cannot change state: only the bounded observation
    // above writes. A live operation that completed meanwhile keeps its result.
    await ctx.db.update(sandboxOperations).set({ state, updatedAt: sql`now()` })
      .where(and(eq(sandboxOperations.id, op.id), eq(sandboxOperations.state, op.state)));
  }
}
