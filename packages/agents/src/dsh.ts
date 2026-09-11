import type { AgentEvent, RunOutcome } from "@bento/core";
import { isOllamaModel, ollamaModelId, ollamaServerUrl } from "@bento/core";
import type { AgentAdapter, BuildCommandInput, McpFile } from "./adapter.js";

/**
 * dsh asks for max_tokens 256000 on every request, DeepSeek's own
 * ceiling, and Ollama refuses anything above the model's output limit:
 * "max_tokens (256000) exceeds model's maximum output tokens (131072)"
 * for gpt-oss:120b. The limit is llm-deepseek plugin config with no flag
 * or variable of its own, so an Ollama run layers this patch over the
 * headless profile. 32768 is well under that limit and ample for a turn.
 * Under /tmp because it is writable on every driver, and it holds no
 * secret.
 */
const OLLAMA_PATCH: McpFile = {
  path: "/tmp/bento/dsh-ollama.patch.yml",
  content: "- id: llm-deepseek\n  config:\n    maxTokens: 32768\n",
};

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
   *
   * An ollama/ model keeps dsh's DeepSeek provider and points it at
   * Ollama's OpenAI compatible API, which that provider already speaks.
   * It appends /chat/completions to the base URL, so /v1 is part of it.
   */
  env(input: BuildCommandInput): Record<string, string> {
    return {
      DSH_MODEL: ollamaModelId(input.model),
      DSH_TOOLS_MODE: "native",
      DSH_PERMISSION_MODE: "danger-full-access",
      DSH_TELEMETRY_DISABLED: "1",
      ...(isOllamaModel(input.model)
        ? {
            DEEPSEEK_BASE_URL: `${ollamaServerUrl(input.credentials?.OLLAMA_BASE_URL)}/v1`,
            DEEPSEEK_API_KEY: input.credentials?.OLLAMA_API_KEY || "ollama",
          }
        : {}),
    };
  },

  files(input: BuildCommandInput): McpFile[] {
    return isOllamaModel(input.model) ? [OLLAMA_PATCH] : [];
  },

  buildCommand(input: BuildCommandInput): string[] {
    const patch = isOllamaModel(input.model) ? ["--patch", OLLAMA_PATCH.path] : [];
    return ["dsh", "--profile", "headless", ...patch, ...(input.extraArgs ?? []), input.prompt];
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
