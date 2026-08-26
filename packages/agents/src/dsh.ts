import type { AgentEvent, RunOutcome } from "@bento/core";
import type { AgentAdapter, BuildCommandInput } from "./adapter.js";

export const dshAdapter: AgentAdapter = {
  cli: "dsh",
  stdoutMode: "text",
  requiredEnv: ["DEEPSEEK_API_KEY"],
  optionalEnv: ["DEEPSEEK_BASE_URL"],

  /**
   * DSH_HOME is deliberately unset. The sandbox shim copies the
   * initialized profile into a fresh directory per invocation so a
   * long-lived card cannot leak prior-run plugin state into the next
   * prompt. Setting it here would pin every run to the shared template.
   */
  env(input: BuildCommandInput): Record<string, string> {
    return {
      DSH_MODEL: input.model,
      DSH_TOOLS_MODE: "native",
      DSH_PERMISSION_MODE: "danger-full-access",
      DSH_TELEMETRY_DISABLED: "1",
    };
  },

  buildCommand(input: BuildCommandInput): string[] {
    return ["dsh", "--profile", "headless", ...(input.extraArgs ?? []), input.prompt];
  },

  parseEvent(_line: string): AgentEvent | null {
    return null;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    if (exitCode !== 0) return { ok: false, error: `dsh stopped before reporting a result (exit code ${exitCode})` };
    return events.some((event) => event.type === "message" && event.role === "assistant")
      ? { ok: true }
      : { ok: false, error: "dsh finished without readable output" };
  },
};
