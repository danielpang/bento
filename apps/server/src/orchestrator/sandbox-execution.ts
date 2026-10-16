import { and, eq, sql } from "drizzle-orm";
import { agentRuns, sandboxes } from "@bento/db";
import type { SandboxExecutionIdentity } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { ownedByMeOrNobody } from "./run-ownership.js";

type Recorded = NonNullable<typeof agentRuns.$inferSelect.sandboxExecution>;
export function executionMatchesSandbox(execution: Recorded, sandbox: { id: string; generation: number; provider: string }): boolean {
  return execution.sandboxId === sandbox.id && execution.generation === sandbox.generation
    && (execution.provider === sandbox.provider || (execution.provider === "local-process" && sandbox.provider === "docker"));
}
export async function recordSandboxExecution(ctx: AppContext, runId: string,
  sandbox: { id: string; generation: number }, execution: SandboxExecutionIdentity): Promise<void> {
  const [written] = await ctx.db.update(agentRuns).set({ sandboxExecution: { ...execution, sandboxId: sandbox.id, generation: sandbox.generation } })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.sandboxId, sandbox.id), ownedByMeOrNobody(ctx),
      sql`${agentRuns.status} in ('starting','running')`,
      sql`exists (select 1 from sandboxes where ${sandboxes.id} = ${sandbox.id} and ${sandboxes.generation} = ${sandbox.generation})`))
    .returning({ id: agentRuns.id });
  if (!written) throw new Error("Run no longer owns this sandbox execution");
}
