import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

/**
 * Test adapter. Emits Claude-style NDJSON from a shell one-liner and makes
 * a commit in the workspace so e2e tests can assert real side effects,
 * without any API keys or agent CLIs installed.
 *
 * Prompt conventions understood by the fake agent:
 *   "FAIL" anywhere in the prompt makes the run fail.
 *   "SLOW" makes it linger, so a test can interrupt a live run.
 *   "VERDICT" makes it reply like a completion judge: COMPLETE, or
 *   INCOMPLETE when the prompt also carries "JUDGE_INCOMPLETE" (a
 *   test plants that through the judge profile's skill).
 *   "ARTIFACT" makes it drop files into the workspace artifacts
 *   directory, so a test can prove they are captured onto the card.
 *   "DEADSESSION" makes a resuming run fail the way claude-code does
 *   when the sandbox no longer holds the conversation; the same
 *   prompt without a resume session succeeds, so tests can prove the
 *   executor's fresh restart.
 */
export const fakeAdapter: AgentAdapter = {
  cli: "fake",
  requiredEnv: [],

  // Exists so orchestrator tests can assert the config write and argv
  // wiring without a real CLI in the sandbox.
  mcp: {
    renderConfig(servers) {
      return [{ path: "/tmp/bento-mcp.json", content: JSON.stringify({ servers }, null, 2) }];
    },
  },

  buildCommand(input: BuildCommandInput): string[] {
    // Resume against a conversation the sandbox lost: an instant error
    // result naming the session, no init, exit 1, like claude-code.
    if (input.prompt.includes("DEADSESSION") && input.resumeSessionId) {
      const session = input.resumeSessionId.replace(/[^a-zA-Z0-9-]/g, "");
      const script = `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"No conversation found with session ID: ${session}","session_id":"${session}","total_cost_usd":0,"num_turns":0}' && exit 1`;
      return ["sh", "-c", script];
    }
    const shouldFail = input.prompt.includes("FAIL");
    // A run that lasts long enough to be cancelled mid-flight.
    const shouldLinger = input.prompt.includes("SLOW");
    const verdict = input.prompt.includes("VERDICT")
      ? input.prompt.includes("JUDGE_INCOMPLETE")
        ? "VERDICT: INCOMPLETE. The fake judge says no."
        : "VERDICT: COMPLETE. The fake judge approves."
      : null;
    // Model is interpolated into a shell string; restrict to safe chars.
    const model = input.model.replace(/[^a-zA-Z0-9._-]/g, "");
    const script = [
      `echo '{"type":"system","subtype":"init","session_id":"fake-session-1","model":"${model}"}'`,
      // The message streams before it lands, like a real tool: two
      // fragments, then the whole message. Tests use these to prove
      // deltas reach the wire and never the transcript. SLOW spaces
      // them out, so the typing is watchable and the fragments spend
      // real time as the only copy on screen.
      `echo '{"type":"delta","channel":"text","text":"Working"}'`,
      ...(shouldLinger ? ["sleep 3"] : []),
      `echo '{"type":"delta","channel":"text","text":" on it."}'`,
      ...(shouldLinger ? ["sleep 3"] : []),
      `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on it."}]}}'`,
      ...(verdict
        ? [`echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${verdict}"}]}}'`]
        : []),
      ...(shouldLinger ? ["sleep 24"] : []),
      // The workspace artifacts directory sits beside the repository
      // checkout, which is where the executor's capture looks.
      ...(input.prompt.includes("ARTIFACT")
        ? [
            "mkdir -p ../artifacts",
            `printf '# Fake plan\\n\\nWritten by the fake agent.' > ../artifacts/fake-plan.md`,
            "printf 'not-really-a-png' > ../artifacts/fake-shot.png",
          ]
        : []),
      "echo fake-artifact > .bento-fake-output",
      "git add -A >/dev/null 2>&1 || true",
      'git -c user.email=fake@bento.dev -c user.name=fake commit -qm "fake agent commit" >/dev/null 2>&1 || true',
      shouldFail
        ? `echo '{"type":"result","subtype":"error","is_error":true,"result":"forced failure","session_id":"fake-session-1","total_cost_usd":0,"num_turns":1}'`
        : `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"fake-session-1","total_cost_usd":0.01,"num_turns":1}'`,
      shouldFail ? "exit 1" : "exit 0",
    ].join(" && ");
    return ["sh", "-c", script];
  },

  /**
   * The live fake: one assistant reply and one result per stdin line,
   * exit on end-of-input. Enough to prove the whole live path (driver
   * stdin, executor delivery, run staying open across turns) in tests
   * without spending a token. A prompt with INTERRUPTIBLE runs a Node
   * version whose turn (20 seconds with SLOW in its message) an
   * interrupt line cuts short with an interrupted result, the way the
   * real CLIs end a turn they were told to stop.
   */
  live: {
    delivery: "queue",
    interrupts: true,
    appliesTo: (input: BuildCommandInput) => input.prompt.includes("LIVE"),
    buildCommand(input: BuildCommandInput): string[] {
      const model = input.model.replace(/[^a-zA-Z0-9._-]/g, "");
      if (input.prompt.includes("INTERRUPTIBLE")) return ["node", "-e", interruptibleFake(model)];
      const script = [
        `echo '{"type":"system","subtype":"init","session_id":"fake-live-1","model":"${model}"}'`,
        "while IFS= read -r line; do",
        `  echo '{"type":"delta","channel":"text","text":"Heard."}'`,
        `  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Heard."}]}}'`,
        "  sleep 2",
        `  echo '{"type":"result","subtype":"success","is_error":false,"session_id":"fake-live-1","total_cost_usd":0,"num_turns":1}'`,
        "done",
        "exit 0",
      ].join("\n");
      return ["sh", "-c", script];
    },
    connect: () => {
      // The fake answers every line with a turn of its own.
      let turns = 0;
      return {
        held: 0,
        get working() {
          return turns > 0;
        },
        // One line per message; the fake only counts lines.
        open: (prompt) => (prompt === null ? [] : (turns++, [fakeLine(prompt)])),
        send: (text) => (turns++, [fakeLine(text)]),
        interrupt: () => [FAKE_INTERRUPT],
        read(line) {
          if (line.includes('"type":"result"')) turns = Math.max(0, turns - 1);
          if (!line.includes('"subtype":"interrupted"')) return { write: [] };
          const cost = (JSON.parse(line) as { total_cost_usd?: number }).total_cost_usd;
          return {
            write: [],
            events: [{ type: "result", ok: false, interrupted: true, error: "Interrupted.", sessionId: "fake-live-1", ...(cost !== undefined ? { costUsd: cost } : {}) }],
          };
        },
      };
    },
  },

  parseEvent(line: string): AgentEvent | null {
    return claudeStyleParse(line);
  },

  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"type":"delta"')) return null;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; channel?: string; text?: string };
      if (parsed.type !== "delta" || typeof parsed.text !== "string") return null;
      return { channel: parsed.channel === "thinking" ? "thinking" : "text", text: parsed.text };
    } catch {
      return null;
    }
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    if (!result) return { ok: false, error: `the fake agent stopped before reporting a result (exit code ${exitCode})` };
    const outcome: RunOutcome = { ok: result.ok && exitCode === 0 };
    if (result.sessionId !== undefined) outcome.sessionId = result.sessionId;
    if (result.costUsd !== undefined) outcome.costUsd = result.costUsd;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};

function claudeStyleParse(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.type === "system") {
    const ev: AgentEvent = { type: "init", raw: parsed };
    if (typeof parsed.session_id === "string") ev.sessionId = parsed.session_id;
    return ev;
  }
  if (parsed.type === "assistant") {
    const message = parsed.message as { content?: { type: string; text?: string }[] } | undefined;
    const text = (message?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    return { type: "message", role: "assistant", text, raw: parsed };
  }
  if (parsed.type === "result") {
    const ev: AgentEvent = { type: "result", ok: parsed.is_error === false, raw: parsed };
    if (typeof parsed.session_id === "string") ev.sessionId = parsed.session_id;
    if (typeof parsed.total_cost_usd === "number") ev.costUsd = parsed.total_cost_usd;
    if (parsed.is_error === true && typeof parsed.result === "string") ev.error = parsed.result;
    return ev;
  }
  return null;
}

/** The line the fake reads as an interrupt. */
const FAKE_INTERRUPT = "BENTO_FAKE_INTERRUPT";

function fakeLine(text: string): string {
  return text.replaceAll(/[\r\n]+/g, " ");
}

/** The interruptible live fake: a turn is a timer, and an interrupt line clears it. */
function interruptibleFake(model: string): string {
  return `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const result = (extra) => out({ type: "result", is_error: false, session_id: "fake-live-1", total_cost_usd: 0, num_turns: 1, subtype: "success", ...extra });
let turn = null;
out({ type: "system", subtype: "init", session_id: "fake-live-1", model: ${JSON.stringify(model)} });
require("readline").createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line === ${JSON.stringify(FAKE_INTERRUPT)}) {
      if (turn) { clearTimeout(turn); turn = null; result({ subtype: "interrupted", is_error: true, total_cost_usd: 0.02 }); }
      return;
    }
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Heard." }] } });
    turn = setTimeout(() => { turn = null; result({}); }, line.includes("SLOW") ? 20000 : 1000);
  })
  .on("close", () => process.exit(0));
`;
}
