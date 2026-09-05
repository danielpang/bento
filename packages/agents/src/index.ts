import type { AgentCli } from "@bento/core";
import type { AgentAdapter } from "./adapter.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { dshAdapter } from "./dsh.js";
import { fakeAdapter } from "./fake.js";
import { piAdapter } from "./pi.js";
import { poolAdapter } from "./pool.js";
import { opencodeAdapter } from "./opencode.js";

export * from "./adapter.js";
export { antigravityAdapter } from "./antigravity.js";
export { claudeCodeAdapter } from "./claude-code.js";
export { codexAdapter } from "./codex.js";
export { cursorAdapter } from "./cursor.js";
export { dshAdapter } from "./dsh.js";
export { piAdapter } from "./pi.js";
export { poolAdapter } from "./pool.js";
export { opencodeAdapter } from "./opencode.js";
export { fakeAdapter } from "./fake.js";

const adapters: Record<AgentCli, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
  pool: poolAdapter,
  dsh: dshAdapter,
  antigravity: antigravityAdapter,
  fake: fakeAdapter,
};

export function getAdapter(cli: AgentCli): AgentAdapter {
  const adapter = adapters[cli];
  if (!adapter) throw new Error(`no adapter registered for cli "${cli}"`);
  return adapter;
}

/** Default model per CLI, used when a profile does not name one. */
export const DEFAULT_MODELS: Record<AgentCli, string> = {
  "claude-code": "claude-sonnet-5",
  codex: "gpt-5-codex",
  cursor: "claude-sonnet-5",
  opencode: "anthropic/claude-sonnet-5",
  // Provider prefixed, which is how pi selects which provider to use.
  pi: "anthropic/claude-sonnet-5",
  // Vendor prefixed, which is the id Poolside's own inference takes.
  pool: "poolside/laguna-s-2.1",
  dsh: "deepseek-v4-pro",
  // Antigravity's own slug for a model tier plus its reasoning effort,
  // which is what its --model takes.
  antigravity: "gemini-3.1-pro-high",
  fake: "fake-1",
};
export { runAgent, type RunAgentInput, type RunAgentResult, type ExecChunk } from "./execute.js";
