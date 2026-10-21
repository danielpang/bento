import type { AgentDelta, AgentEvent } from "@bento/core";
import type { BuildCommandInput, LiveProtocol } from "./adapter.js";
import { METHOD_NOT_FOUND, readRpcLine, RpcCalls, type RpcLine } from "./live-wire.js";

/**
 * A live Codex session over `codex app-server`, its JSON-RPC server on
 * stdio (Codex's own name for the protocol its IDE extensions use).
 *
 * What a Bento run needs from it, each verified against codex-cli
 * 0.163.0 driven over stdio against a stand-in Responses API:
 *
 * - The handshake is `initialize`, the `initialized` notification, then
 *   `thread/start` (or `thread/resume` for a session a previous run
 *   left). The three can be written without waiting; the thread id
 *   comes back in the answer to the third, and every turn names it.
 * - `turn/start` on a thread with a turn running steers that turn: the
 *   model call in flight is cut short and the next one carries the new
 *   message. So a message is always `turn/start`, and nothing here has
 *   to know whether a turn is running. (`turn/steer` would need the
 *   running turn's id and fails once the turn has ended.)
 * - `turn/completed` ends a turn. Its usage arrived before it in
 *   `thread/tokenUsage/updated`, one notification per model call, whose
 *   `last` field is that call's own count; the turn's usage is their sum.
 * - The server asks questions of its own (approvals, a question for the
 *   user, an MCP elicitation) and waits for the answer, so every request
 *   gets one. Approvals cannot come at all with approvalPolicy "never",
 *   and are accepted if they do: the sandbox is the boundary, the same
 *   reason `codex exec` runs with --dangerously-bypass-approvals-and-sandbox.
 * - End of input ends the process with exit code 0, which is how Bento
 *   ends every live run.
 */
export function codexAppServerProtocol(
  input: BuildCommandInput,
  how: { attach: boolean },
  options: { model: string },
): LiveProtocol {
  const rpc = new RpcCalls<"initialize" | "thread" | "turn">(false);
  const resuming = input.resumeSessionId;
  let threadId: string | undefined = how.attach ? resuming : undefined;
  // A reattached process whose thread id was never recorded cannot be
  // addressed: its messages go back on the card for the next run.
  let failed = how.attach && !threadId;
  const held: string[] = [];
  const usage = new Map<string, { input: number; output: number }>();

  const threadParams = {
    cwd: input.cwd,
    model: options.model,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  const turn = (text: string) =>
    rpc.request("turn", "turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  const release = () => held.splice(0).map(turn);

  return {
    get held() {
      return held.length;
    },

    open(prompt) {
      if (prompt !== null && !failed) held.push(prompt);
      if (how.attach) return threadId ? release() : [];
      return [
        rpc.request("initialize", "initialize", { clientInfo: { name: "bento", version: "1" }, capabilities: null }),
        rpc.notify("initialized"),
        resuming
          ? rpc.request("thread", "thread/resume", { threadId: resuming, ...threadParams })
          : rpc.request("thread", "thread/start", threadParams),
      ];
    },

    send(text) {
      if (failed) return null;
      if (!threadId) {
        held.push(text);
        return [];
      }
      return [turn(text)];
    },

    read(line) {
      const message = readRpcLine(line);
      if (!message) return { write: [] };
      if (message.kind === "request") return { write: [answer(rpc, message)], events: [] };
      if (message.kind === "response") {
        const tag = rpc.settle(message.id);
        if (!tag) return { write: [], events: [] };
        if (message.error) {
          // A turn that would not start fails that turn. A handshake that
          // failed fails the process: nothing can be addressed without it.
          if (tag !== "turn") {
            failed = true;
            held.length = 0;
          }
          return { write: [], events: [{ type: "result", ok: false, error: handshakeError(tag, message, resuming), raw: message }] };
        }
        if (tag === "thread") {
          const id = (message.result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
          if (typeof id !== "string") return { write: [], events: [] };
          threadId = id;
          return { write: release(), events: [{ type: "init", sessionId: id, model: options.model, raw: message }] };
        }
        return { write: [], events: [] };
      }
      if (message.method === "thread/tokenUsage/updated") {
        const params = message.params as { turnId?: unknown; tokenUsage?: { last?: { inputTokens?: unknown; outputTokens?: unknown } } };
        const last = params.tokenUsage?.last;
        if (typeof params.turnId === "string" && last) {
          const sum = usage.get(params.turnId) ?? { input: 0, output: 0 };
          if (typeof last.inputTokens === "number") sum.input += last.inputTokens;
          if (typeof last.outputTokens === "number") sum.output += last.outputTokens;
          usage.set(params.turnId, sum);
        }
        return { write: [], events: [] };
      }
      if (message.method === "turn/completed") {
        const result = turnResult(message.params, threadId);
        const turnId = (message.params as { turn?: { id?: unknown } }).turn?.id;
        const counted = typeof turnId === "string" ? usage.get(turnId) : undefined;
        if (typeof turnId === "string") usage.delete(turnId);
        if (counted) {
          result.inputTokens = counted.input;
          result.outputTokens = counted.output;
        }
        return { write: [], events: [result] };
      }
      return { write: [] };
    },
  };
}

/**
 * What a turn's end says. Interrupted counts as a failure: Bento only
 * interrupts by ending the process, so an interruption it did not ask
 * for is Codex giving up.
 */
function turnResult(params: unknown, threadId: string | undefined): Extract<AgentEvent, { type: "result" }> {
  const turn = (params as { turn?: { status?: unknown; error?: { message?: unknown } | null } } | undefined)?.turn;
  const ok = turn?.status === "completed";
  const result: Extract<AgentEvent, { type: "result" }> = { type: "result", ok, raw: params };
  if (threadId) result.sessionId = threadId;
  if (!ok) {
    const reason = typeof turn?.error?.message === "string" ? turn.error.message : undefined;
    result.error = reason ?? (turn?.status === "interrupted" ? "Codex interrupted the turn" : "turn failed");
  }
  return result;
}

/**
 * A handshake failure, in words the executor already acts on. A resume
 * of a thread the sandbox no longer holds reads "no rollout found for
 * thread id ..."; it is reported the way Claude Code reports a lost
 * conversation, which is what starts a fresh run in its place.
 */
function handshakeError(tag: string, message: Extract<RpcLine, { kind: "response" }>, resuming: string | undefined): string {
  const said = message.error?.message ?? "no reason given";
  if (tag === "thread" && resuming && /no rollout found/i.test(said)) {
    return `No conversation found with session ID: ${resuming} (Codex: ${said})`;
  }
  const step = tag === "thread" ? (resuming ? "resume the thread" : "start a thread") : tag === "turn" ? "start the turn" : "initialize";
  return `Codex could not ${step}: ${said}`;
}

/**
 * The answer to each question the server asks. Nobody is at a keyboard
 * in a Bento run, so a question for the user gets no answers and an MCP
 * elicitation is declined, the way Muse runs with
 * --user-input-auto-resolve. Bento registers no client-side tools, so a
 * call to one fails. Anything else is refused as unknown rather than
 * left unanswered, because the server would wait on it forever.
 */
function answer(rpc: RpcCalls<string>, request: Extract<RpcLine, { kind: "request" }>): string {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return rpc.reply(request.id, { decision: "acceptForSession" });
    case "execCommandApproval":
    case "applyPatchApproval":
      return rpc.reply(request.id, { decision: "approved_for_session" });
    case "item/tool/requestUserInput":
      return rpc.reply(request.id, { answers: {} });
    case "mcpServer/elicitation/request":
      return rpc.reply(request.id, { action: "decline", content: null, _meta: null });
    case "item/tool/call":
      return rpc.reply(request.id, { contentItems: [], success: false });
    default:
      return rpc.refuse(request.id, METHOD_NOT_FOUND, `Bento does not answer ${request.method}`);
  }
}

interface AppServerItem {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  status?: string;
  changes?: unknown[];
  server?: string;
  tool?: string;
}

/**
 * The stateless half: notifications that read the same whoever is
 * listening. Shared by parseEvent, so a line replayed after a reattach
 * renders the way it did the first time.
 */
export function parseAppServerEvent(method: string, params: unknown): AgentEvent | null {
  const raw = { method, params };
  switch (method) {
    case "thread/started": {
      const id = (params as { thread?: { id?: unknown } }).thread?.id;
      return typeof id === "string" ? { type: "init", sessionId: id, raw } : { type: "init", raw };
    }
    case "item/started":
    case "item/completed": {
      const item = (params as { item?: AppServerItem }).item;
      if (!item) return null;
      const phase = method === "item/started" ? "start" : "end";
      if (item.type === "agentMessage") {
        return phase === "end" && item.text ? { type: "message", role: "assistant", text: item.text, raw } : null;
      }
      if (item.type === "commandExecution") {
        return { type: "tool", name: item.command ?? "command", phase, detail: item.status, raw };
      }
      if (item.type === "fileChange") {
        return { type: "tool", name: "file_change", phase, detail: item.status, raw };
      }
      if (item.type === "mcpToolCall") {
        return { type: "tool", name: [item.server, item.tool].filter(Boolean).join(".") || "mcp", phase, detail: item.status, raw };
      }
      if (item.type === "webSearch") return { type: "tool", name: "web_search", phase, raw };
      return null;
    }
    case "turn/completed": {
      // Normally replaced by the protocol, which knows the usage. Read
      // here too so the line means the same thing to any reader.
      return turnResult(params, (params as { threadId?: string }).threadId);
    }
    default:
      return null;
  }
}

/** Token fragments, forwarded live and never stored. */
export function parseAppServerDelta(method: string, params: unknown): Pick<AgentDelta, "channel" | "text"> | null {
  const delta = (params as { delta?: unknown } | undefined)?.delta;
  switch (method) {
    case "item/agentMessage/delta":
      return { channel: "text", text: typeof delta === "string" ? delta : "" };
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return { channel: "thinking", text: typeof delta === "string" ? delta : "" };
    default:
      // Every other streaming notification is chatter: consumed, so a
      // failing run's error tail holds the reason rather than output.
      return /Delta$|\/delta$|outputDelta$/.test(method) ? { channel: "text", text: "" } : null;
  }
}
