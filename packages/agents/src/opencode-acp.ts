import type { AgentDelta, AgentEvent } from "@bento/core";
import type { BuildCommandInput, LiveProtocol } from "./adapter.js";
import { METHOD_NOT_FOUND, readRpcLine, RpcCalls, type RpcLine } from "./live-wire.js";

/**
 * A live opencode session over `opencode acp`, its Agent Client
 * Protocol server: JSON-RPC 2.0 on stdio.
 *
 * What a Bento run needs from it, each verified against opencode 1.19.3
 * driven over stdio against a stand-in Chat Completions API:
 *
 * - The handshake is `initialize`, then `session/new` (or
 *   `session/resume` for a session a previous run left), whose answer
 *   names the session every prompt must carry.
 * - `opencode acp` takes no model flag. `session/set_config_option`
 *   with configId "model" selects one, by the same `provider/model`
 *   string `opencode run -m` takes, and a resumed session keeps it.
 * - A turn is a `session/prompt` request, and its answer
 *   (`stopReason`, `usage`) is the turn's end. A prompt sent while one
 *   runs is queued by opencode itself: the next model call carries both,
 *   and both answers arrive when the work ends. So the turn ends for
 *   Bento when no prompt is outstanding.
 * - Text arrives only as `agent_message_chunk` fragments, each naming
 *   the opencode message it belongs to. There is no "message finished"
 *   event, so a message is assembled here and goes to the transcript
 *   when a different message, a tool call, or the turn's end arrives.
 * - Permission requests (`session/request_permission`) are answered
 *   with the option that allows, the way `opencode run --auto` does: the
 *   sandbox is the boundary.
 * - End of input ends the process with exit code 0.
 * - `session/cancel` (a notification) ends the running prompt at once
 *   with `stopReason` "cancelled". The process stays up, and the next
 *   prompt continues the session with everything before it.
 */
export function opencodeAcpProtocol(input: BuildCommandInput, how: { attach: boolean }): LiveProtocol {
  const rpc = new RpcCalls<"initialize" | "session" | "model" | "prompt">(true);
  const resuming = input.resumeSessionId;
  let sessionId: string | undefined = how.attach ? resuming : undefined;
  let ready = how.attach && Boolean(sessionId);
  let failed = how.attach && !sessionId;
  const held: string[] = [];
  let outstanding = 0;
  let turnUsage: { input: number; output: number } | null = null;
  let stop: string | null = null;
  // Whether Bento asked for the running prompt to stop, and whether it did.
  let interrupting = false;
  let cancelled = false;
  let draft: { messageId: string | undefined; role: "assistant" | "system"; text: string } | null = null;

  const prompt = (text: string) => {
    outstanding += 1;
    return rpc.request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  };
  const release = () => held.splice(0).map(prompt);

  /** The message being assembled, as a transcript event, and a fresh start. */
  const flush = (): AgentEvent[] => {
    const done = draft;
    draft = null;
    if (!done || !done.text) return [];
    const raw = {
      type: done.role === "assistant" ? "text" : "reasoning",
      acp: true,
      sessionID: sessionId,
      // No part id: ACP names the message, not the part. Session
      // recovery matches a one-part message by its message id alone.
      part: { messageID: done.messageId, type: done.role === "assistant" ? "text" : "reasoning", text: done.text },
    };
    return [{ type: "message", role: done.role, text: done.text, raw }];
  };

  const fail = (error: string, raw: unknown): { write: string[]; events: AgentEvent[] } => {
    failed = true;
    held.length = 0;
    return { write: [], events: [...flush(), { type: "result", ok: false, error, raw }] };
  };

  return {
    get held() {
      return held.length;
    },

    open(text) {
      if (text !== null && !failed) held.push(text);
      if (how.attach) return ready ? release() : [];
      return [
        rpc.request("initialize", "initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }),
      ];
    },

    send(text) {
      if (failed) return null;
      if (!ready) {
        held.push(text);
        return [];
      }
      return [prompt(text)];
    },

    interrupt() {
      // Nothing to cancel without a session and a prompt still running.
      if (!sessionId || outstanding === 0) return [];
      interrupting = true;
      return [rpc.notify("session/cancel", { sessionId })];
    },

    read(line) {
      const message = readRpcLine(line);
      if (!message) return { write: [] };
      if (message.kind === "request") return { write: [answer(rpc, message)], events: [] };

      if (message.kind === "response") {
        const tag = rpc.settle(message.id);
        if (!tag) return { write: [], events: [] };
        const said = message.error?.message ?? "no reason given";
        switch (tag) {
          case "initialize":
            if (message.error) return fail(`opencode could not initialize: ${said}`, message);
            return {
              write: [
                resuming
                  ? rpc.request("session", "session/resume", { sessionId: resuming, cwd: input.cwd, mcpServers: [] })
                  : rpc.request("session", "session/new", { cwd: input.cwd, mcpServers: [] }),
              ],
              events: [],
            };
          case "session": {
            if (message.error) {
              return fail(`opencode could not ${resuming ? `resume session ${resuming}` : "start a session"}: ${said}`, message);
            }
            const id = resuming ?? (message.result as { sessionId?: unknown } | undefined)?.sessionId;
            if (typeof id !== "string") return fail("opencode started a session without naming it", message);
            sessionId = id;
            return {
              write: [rpc.request("model", "session/set_config_option", { sessionId: id, configId: "model", value: input.model })],
              events: [{ type: "init", sessionId: id, model: input.model, raw: message }],
            };
          }
          case "model":
            if (message.error) return fail(`opencode cannot use model ${input.model}: ${said}`, message);
            ready = true;
            return { write: release(), events: [] };
          case "prompt": {
            outstanding = Math.max(0, outstanding - 1);
            const events = flush();
            const result = message.result as { stopReason?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } } | undefined;
            if (message.error) {
              stop = `opencode failed the turn: ${said}`;
            } else {
              if (interrupting && result?.stopReason === "cancelled") cancelled = true;
              else if (result?.stopReason !== "end_turn" && !stop) stop = stopReasonError(result?.stopReason);
              const used = result?.usage;
              if (used && (typeof used.inputTokens === "number" || typeof used.outputTokens === "number")) {
                turnUsage ??= { input: 0, output: 0 };
                if (typeof used.inputTokens === "number") turnUsage.input += used.inputTokens;
                if (typeof used.outputTokens === "number") turnUsage.output += used.outputTokens;
              }
            }
            if (outstanding > 0) return { write: [], events };
            const end: Extract<AgentEvent, { type: "result" }> = { type: "result", ok: stop === null && !cancelled, raw: message };
            if (sessionId) end.sessionId = sessionId;
            if (stop) end.error = stop;
            else if (cancelled) {
              end.interrupted = true;
              end.error = "Interrupted.";
            }
            interrupting = false;
            cancelled = false;
            if (turnUsage) {
              end.inputTokens = turnUsage.input;
              end.outputTokens = turnUsage.output;
            }
            stop = null;
            turnUsage = null;
            return { write: [], events: [...events, end] };
          }
        }
        return { write: [], events: [] };
      }

      if (message.method !== "session/update") return { write: [], events: [] };
      const update = (message.params as { update?: AcpUpdate } | undefined)?.update;
      switch (update?.sessionUpdate) {
        case "agent_message_chunk":
        case "agent_thought_chunk": {
          const role = update.sessionUpdate === "agent_message_chunk" ? "assistant" : "system";
          const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
          const events = draft && (draft.messageId !== update.messageId || draft.role !== role) ? flush() : [];
          draft ??= { messageId: update.messageId, role, text: "" };
          draft.text += text;
          return { write: [], events };
        }
        case "tool_call":
          return {
            write: [],
            events: [...flush(), { type: "tool", name: toolName(update), phase: "start", detail: update.status, raw: message.params }],
          };
        case "tool_call_update":
          if (update.status !== "completed" && update.status !== "failed") return { write: [], events: [] };
          return {
            write: [],
            events: [...flush(), { type: "tool", name: toolName(update), phase: "end", detail: update.status, raw: message.params }],
          };
        default:
          return { write: [], events: [] };
      }
    },
  };
}

interface AcpUpdate {
  sessionUpdate?: string;
  messageId?: string;
  content?: { type?: string; text?: unknown };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: { command?: unknown };
}

/** The command for a shell call, as the one-shot stream names it; the title otherwise. */
function toolName(update: AcpUpdate): string {
  const command = update.rawInput?.command;
  if (typeof command === "string" && command) return command;
  return update.title ?? update.kind ?? "tool";
}

function stopReasonError(reason: unknown): string {
  switch (reason) {
    case "max_tokens":
      return "opencode stopped: the model reached its output limit";
    case "max_turn_requests":
      return "opencode stopped: the turn reached its step limit";
    case "refusal":
      return "opencode stopped: the model refused";
    case "cancelled":
      return "opencode cancelled the turn";
    default:
      return `opencode stopped: ${typeof reason === "string" ? reason : "no reason given"}`;
  }
}

/**
 * Permission requests get the option that allows, preferring the one
 * that lasts the session. Bento advertised no file system or terminal
 * of its own, so a call to one is refused rather than left waiting.
 */
function answer(rpc: RpcCalls<string>, request: Extract<RpcLine, { kind: "request" }>): string {
  if (request.method === "session/request_permission") {
    const options = (request.params as { options?: { optionId?: string; kind?: string }[] } | undefined)?.options ?? [];
    const pick = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once");
    return pick?.optionId
      ? rpc.reply(request.id, { outcome: { outcome: "selected", optionId: pick.optionId } })
      : rpc.reply(request.id, { outcome: { outcome: "cancelled" } });
  }
  return rpc.refuse(request.id, METHOD_NOT_FOUND, `Bento does not answer ${request.method}`);
}

/** Token fragments of the message or thinking being written, forwarded live. */
export function parseAcpDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
  if (!line.includes('"session/update"') || !/"agent_(message|thought)_chunk"/.test(line)) return null;
  const message = readRpcLine(line);
  if (message?.kind !== "notification") return null;
  const update = (message.params as { update?: AcpUpdate } | undefined)?.update;
  const text = update?.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
  if (update?.sessionUpdate === "agent_message_chunk") return { channel: "text", text };
  if (update?.sessionUpdate === "agent_thought_chunk") return { channel: "thinking", text };
  return null;
}
