import type { GateCriterion } from "@bento/core";
import type { GitHubClient, PullRequestRef } from "@bento/github";
import type { ExecChunk, SandboxHandle } from "@bento/sandbox";

export type GateStatus = "pending" | "passed" | "failed";

export interface GateResult {
  status: GateStatus;
  /** Human readable reason shown on the card. */
  detail: string;
  /** Structured extras persisted alongside the check. */
  data?: Record<string, unknown>;
}

/**
 * What an evaluator is allowed to look at. Everything is optional so a
 * criterion can report "pending" with a clear reason (no PR yet, no
 * sandbox yet) rather than failing the whole gate.
 */
export interface GateContext {
  /** Terminal status of the stage's most recent run, if any. */
  lastRunStatus?: "succeeded" | "failed" | "cancelled";
  /** Whether a human has approved this stage. */
  manuallyApproved: boolean;
  /**
   * Every pull request the feature has open, one per repository it
   * changed. A card spanning a frontend and a backend is only finished
   * when both are, so these criteria read all of them.
   */
  prs?: PullRequestRef[];
  github?: GitHubClient;
  sandbox?: {
    handle: SandboxHandle;
    exec(handle: SandboxHandle, argv: string[], opts?: { cwd?: string; timeoutMs?: number }): AsyncIterable<ExecChunk>;
  };
  /**
   * Runs (or reads) the agent-judge verdict for an agent_judge
   * criterion. Supplied by the server, which owns runs; the evaluator
   * itself stays a pure function over the context.
   */
  judge?(criterion: Extract<GateCriterion, { type: "agent_judge" }>): Promise<GateResult>;
}

export async function evaluateCriterion(criterion: GateCriterion, ctx: GateContext): Promise<GateResult> {
  switch (criterion.type) {
    case "manual":
      return ctx.manuallyApproved
        ? { status: "passed", detail: "Approved" }
        : { status: "pending", detail: "Waiting for approval" };

    /**
     * The stage's agent finished, and finished well. A failed or
     * cancelled run FAILS rather than staying pending: the work is over
     * and it did not go well, so the card should stop where someone can
     * see it rather than wait for something that is not coming.
     */
    case "run_succeeded": {
      if (!ctx.lastRunStatus) return { status: "pending", detail: "Waiting for the agent to run" };
      if (ctx.lastRunStatus === "succeeded") return { status: "passed", detail: "The agent finished" };
      return {
        status: "failed",
        detail: ctx.lastRunStatus === "cancelled" ? "The agent was stopped" : "The agent failed",
      };
    }

    case "agent_judge": {
      if (!ctx.judge) {
        return { status: "pending", detail: "The judge agent has not looked at this work yet" };
      }
      return ctx.judge(criterion);
    }

    case "pr_comments_resolved": {
      const prs = ctx.prs ?? [];
      // Two different problems, told apart: without GitHub connected no
      // amount of PR-linking helps, and saying "link a PR" would send
      // the user to the wrong door.
      if (!ctx.github) {
        return { status: "pending", detail: "GitHub is not connected. Connect the GitHub App, then re-check." };
      }
      if (prs.length === 0) {
        return { status: "pending", detail: "No pull request yet. One is opened when the agent's work is published." };
      }
      // Summed across every repository the card touched: one repo left
      // with unresolved comments is the card not being finished, and
      // reporting only the first would hide it.
      let total = 0;
      let unresolved = 0;
      const blocking: string[] = [];
      for (const pr of prs) {
        const threads = await ctx.github.reviewThreads(pr);
        total += threads.total;
        unresolved += threads.unresolved;
        if (threads.unresolved > 0) blocking.push(`${pr.repo} #${pr.prNumber}`);
      }
      if (unresolved > 0) {
        return {
          status: "failed",
          detail: `${unresolved} unresolved review ${unresolved === 1 ? "comment" : "comments"} in ${blocking.join(", ")}`,
          data: { total, unresolved },
        };
      }
      return {
        status: "passed",
        detail: prs.length === 1 ? "All review comments resolved" : `All review comments resolved in ${prs.length} repositories`,
        data: { total, unresolved },
      };
    }

    case "checks_pass": {
      const prs = ctx.prs ?? [];
      if (!ctx.github) {
        return { status: "pending", detail: "GitHub is not connected. Connect the GitHub App, then re-check." };
      }
      if (prs.length === 0) {
        return { status: "pending", detail: "No pull request yet. One is opened when the agent's work is published." };
      }
      let total = 0;
      let pending = 0;
      let failed = 0;
      const failing: string[] = [];
      for (const pr of prs) {
        const checks = await ctx.github.checks(pr);
        total += checks.total;
        pending += checks.pending;
        failed += checks.failed;
        if (checks.failed > 0) failing.push(`${pr.repo} #${pr.prNumber}`);
      }
      const data = { total, pending, failed };
      // Failure is reported before pending: once one repository's checks
      // have failed the card is not advancing, and waiting on another
      // repository's still-running checks only delays saying so.
      if (failed > 0) return { status: "failed", detail: `${failed} checks failed in ${failing.join(", ")}`, data };
      if (pending > 0) return { status: "pending", detail: `${pending} checks still running`, data };
      return { status: "passed", detail: total === 0 ? "No checks configured" : "All checks passed", data };
    }

    case "command": {
      if (!ctx.sandbox) {
        return { status: "pending", detail: "No sandbox exists for this card yet. Run an agent on this stage first." };
      }
      // A shell is intended here: the criterion IS a user-authored shell
      // command ("pnpm test && pnpm lint"), and it runs inside the
      // feature's sandbox, never on the host.
      const argv = ["sh", "-c", criterion.cmd];
      let stdout = "";
      let stderr = "";
      let exitCode = -1;
      for await (const chunk of ctx.sandbox.exec(ctx.sandbox.handle, argv, {
        cwd: ctx.sandbox.handle.workdir,
        timeoutMs: criterion.timeoutSec * 1000,
      })) {
        if (chunk.kind === "stdout") stdout += chunk.data;
        else if (chunk.kind === "stderr") stderr += chunk.data;
        else exitCode = chunk.exitCode;
      }
      const tail = (stderr || stdout).trim().split("\n").slice(-3).join("\n");
      // -1 means no exit chunk ever arrived, which is a timeout, not a
      // command failure; "exited -1" would blame the command.
      if (exitCode === -1) {
        return {
          status: "failed",
          detail: `${criterion.cmd} did not finish within ${criterion.timeoutSec} seconds`,
          data: { exitCode },
        };
      }
      return exitCode === 0
        ? { status: "passed", detail: `${criterion.cmd} passed`, data: { exitCode } }
        : { status: "failed", detail: `${criterion.cmd} exited ${exitCode}${tail ? `: ${tail}` : ""}`, data: { exitCode } };
    }
  }
}

export interface CriterionOutcome {
  criterion: GateCriterion;
  result: GateResult;
}

export interface GateOutcome {
  /** True only when every criterion passed. */
  passed: boolean;
  outcomes: CriterionOutcome[];
}

/**
 * Evaluates every criterion. Criteria are evaluated even after one fails
 * so the card shows the full picture rather than only the first problem.
 */
export async function evaluateGate(criteria: GateCriterion[], ctx: GateContext): Promise<GateOutcome> {
  const outcomes: CriterionOutcome[] = [];
  for (const criterion of criteria) {
    try {
      outcomes.push({ criterion, result: await evaluateCriterion(criterion, ctx) });
    } catch (err) {
      outcomes.push({ criterion, result: { status: "failed", detail: `Evaluation error: ${String(err)}` } });
    }
  }
  return { passed: outcomes.length > 0 && outcomes.every((o) => o.result.status === "passed"), outcomes };
}
