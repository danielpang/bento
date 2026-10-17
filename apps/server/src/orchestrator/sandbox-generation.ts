import { and, eq } from "drizzle-orm";
import { sandboxes } from "@bento/db";
import type { AppContext } from "../context.js";

export type SandboxGeneration = { id: string; generation: number };
export function matchesSandboxGeneration(row: SandboxGeneration, expected?: readonly SandboxGeneration[]): boolean {
  return expected === undefined || expected.some((target) => target.id === row.id && target.generation === row.generation);
}
/** Last check before a provider mutation. Keep the row locked through the mutation. */
export async function withSandboxGeneration<T>(ctx: AppContext, row: typeof sandboxes.$inferSelect, work: () => Promise<T>): Promise<T | undefined> {
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(sandboxes).where(and(eq(sandboxes.id, row.id), eq(sandboxes.generation, row.generation))).for("update");
    if (!current || current.externalId !== row.externalId || current.provider !== row.provider || current.status === "destroyed") return undefined;
    return work();
  });
}
