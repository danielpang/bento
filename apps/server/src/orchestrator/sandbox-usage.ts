import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { sandboxes, sandboxUsageLeases } from "@bento/db";
import type { ExecOptions, SandboxDriver, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";

type Db = AppContext["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const USAGE_LEASE_MS = 90_000;
export class SandboxInUse extends Error {
  constructor() { super("Sandbox is in use; its lifecycle operation must wait"); this.name = "SandboxInUse"; }
}
export class SandboxUsageLost extends Error {
  constructor() { super("Sandbox usage lease could not be renewed"); this.name = "SandboxUsageLost"; }
}

/** Called under the sandbox row lock, shared with lease acquisition. */
export async function sandboxHasUsage(db: Db | Tx, sandboxId: string): Promise<boolean> {
  const [lease] = await db.select({ id: sandboxUsageLeases.id }).from(sandboxUsageLeases).where(and(
    eq(sandboxUsageLeases.sandboxId, sandboxId), gt(sandboxUsageLeases.expiresAt, sql`now()`),
  )).limit(1);
  return Boolean(lease);
}

export async function acquireSandboxUsage(ctx: AppContext, sandboxId: string, purpose: string) {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).for("update");
    if (!row || row.status === "destroyed") throw new SandboxUsageLost();
    const [lease] = await tx.insert(sandboxUsageLeases).values({ sandboxId, purpose, generation: row.generation,
      expiresAt: sql`now() + interval '90 seconds'` }).returning();
    if (!lease) throw new SandboxUsageLost();
    return lease;
  });
}

export async function renewSandboxUsage(ctx: AppContext, id: string): Promise<boolean> {
  // Never resurrect a lease after expiry: cleanup may already have claimed the machine.
  const rows = await ctx.db.update(sandboxUsageLeases).set({ expiresAt: sql`now() + interval '90 seconds'` })
    .where(and(eq(sandboxUsageLeases.id, id), gt(sandboxUsageLeases.expiresAt, sql`now()`),
      sql`exists (select 1 from sandboxes s where s.id = ${sandboxUsageLeases.sandboxId}
        and s.generation = ${sandboxUsageLeases.generation} and s.status <> 'destroyed')`))
    .returning({ id: sandboxUsageLeases.id });
  return rows.length === 1;
}

async function holdUsage(ctx: AppContext, sandboxId: string, purpose: string) {
  const lease = await acquireSandboxUsage(ctx, sandboxId, purpose);
  const controller = new AbortController();
  let closed = false;
  let renewing = false;
  let deadline = setTimeout(() => controller.abort(new SandboxUsageLost()), USAGE_LEASE_MS - 5_000);
  deadline.unref();
  const timer = setInterval(async () => {
    if (renewing || closed || controller.signal.aborted) return;
    renewing = true;
    try {
      if (!await renewSandboxUsage(ctx, lease.id)) throw new SandboxUsageLost();
      if (!closed && !controller.signal.aborted) {
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(new SandboxUsageLost()), USAGE_LEASE_MS - 5_000);
        deadline.unref();
      }
    } catch { controller.abort(new SandboxUsageLost()); }
    finally { renewing = false; }
  }, 20_000);
  timer.unref();
  return { signal: controller.signal, release: async () => {
    closed = true;
    clearTimeout(timer); clearTimeout(deadline);
    await ctx.db.delete(sandboxUsageLeases).where(eq(sandboxUsageLeases.id, lease.id));
  } };
}

const current = new AsyncLocalStorage<{ sandboxId: string; signal: AbortSignal }>();
export async function withSandboxUsage<T>(ctx: AppContext, sandboxId: string, purpose: string,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const held = current.getStore();
  if (held?.sandboxId === sandboxId) { held.signal.throwIfAborted(); return work(held.signal); }
  const lease = await holdUsage(ctx, sandboxId, purpose);
  try {
    const result = await current.run({ sandboxId, signal: lease.signal }, () => work(lease.signal));
    lease.signal.throwIfAborted();
    return result;
  } finally { await lease.release(); }
}

/** One interface covers runs, exports, imports, checks, and publishing callers. */
export function usingSandboxDriver(ctx: AppContext, driver: SandboxDriver, sandboxId: string): SandboxDriver {
  const signals = (opts: ExecOptions | undefined, signal: AbortSignal): ExecOptions => {
    const combined = opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal;
    // Cancellation may arrive while acquiring the lease. Some drivers listen
    // only for future abort events, so never start them with an aborted signal.
    combined.throwIfAborted();
    return { ...opts, signal: combined };
  };
  const proxy: SandboxDriver = new Proxy(driver, {
    get(target, property) {
      if (property === "exec") return async function* (handle: SandboxHandle, argv: string[], opts?: ExecOptions) {
        const held = current.getStore();
        if (held?.sandboxId === sandboxId) {
          held.signal.throwIfAborted();
          yield* target.exec(handle, argv, signals(opts, held.signal));
          return;
        }
        const lease = await holdUsage(ctx, sandboxId, "command");
        try {
          yield* target.exec(handle, argv, signals(opts, lease.signal));
          lease.signal.throwIfAborted();
        } finally { await lease.release(); }
      };
      if (property === "attach" && target.attach) return async (handle: SandboxHandle, argv: string[], opts?: ExecOptions) => {
        const lease = await holdUsage(ctx, sandboxId, "reattach");
        try {
          const stream = await target.attach!(handle, argv, signals(opts, lease.signal));
          if (!stream) { await lease.release(); return null; }
          return (async function* () {
            try { yield* stream; lease.signal.throwIfAborted(); }
            finally { await lease.release(); }
          })();
        } catch (err) { await lease.release(); throw err; }
      };
      const value = Reflect.get(target, property, target);
      if ((property === "exportRepository" || property === "importRepository") && typeof value === "function") {
        return (...args: unknown[]) => withSandboxUsage(ctx, sandboxId, property, () => value.apply(proxy, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

/** Expired receipts are not live claims and need no permanent history. */
export async function pruneSandboxUsage(ctx: AppContext): Promise<void> {
  await ctx.db.delete(sandboxUsageLeases).where(lt(sandboxUsageLeases.expiresAt, sql`now() - interval '1 day'`));
}
