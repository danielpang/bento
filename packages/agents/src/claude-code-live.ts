import type { AgentEvent } from "@bento/core";
import type { LiveAsk, LiveProtocol } from "./adapter.js";
import { readAskQuestions } from "./ask-questions.js";

/**
 * Claude Code's live session: stream-json on stdin and stdout.
 *
 * Messages are one JSON line each, as they always were. On top of that,
 * the CLI's control protocol, each part verified against Claude Code
 * 2.1.306 driven over stdio against a stand-in Messages API:
 *
 * - An interrupt is `{type:"control_request", request:{subtype:"interrupt"}}`.
 *   The CLI answers it, logs "[Request interrupted by user]", and ends
 *   the turn with an `error_during_execution` result, but the process
 *   stays up: the next message continues the same session.
 * - With `--permission-prompt-tool stdio`, AskUserQuestion is available
 *   (without it the CLI disables the tool) and each call arrives as a
 *   `can_use_tool` control request flagged `requires_user_interaction`.
 *   The answer is `{behavior:"allow", updatedInput:{...input, answers}}`,
 *   with `answers` keyed by question text and a multiple choice answer
 *   comma separated; the model reads "Your questions have been
 *   answered: ...". `{behavior:"deny", message}` reaches the model as
 *   the tool's error. Every other tool still runs without asking under
 *   --dangerously-skip-permissions, so this asks nothing else.
 * - An interrupt while a question waits withdraws it with a
 *   `control_cancel_request` naming the request.
 *
 * The protocol keeps no state that matters after a restart: an answer
 * is built from the stored request id and input alone, so a server that
 * reattached can answer a question its predecessor saw asked.
 */
export function claudeCodeLiveProtocol(): LiveProtocol {
  // The interrupt Bento sent and the CLI has not refused, until a turn ends.
  let interrupting: string | null = null;
  /**
   * Messages written since the last turn began. The CLI opens every
   * turn with a system init line and takes all the messages waiting at
   * that moment into it (verified on the real CLI: two messages sent
   * mid turn were one more turn, not two).
   */
  let waitingForTurn = 0;
  let next = 0;
  const prefix = `bento-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const line = (message: unknown) => JSON.stringify(message);
  const reply = (requestId: string, response: unknown) =>
    line({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });

  const message = (text: string) => {
    waitingForTurn += 1;
    return [encodeClaudeMessage(text)];
  };

  return {
    held: 0,
    get working() {
      return waitingForTurn > 0;
    },
    open: (prompt) => (prompt === null ? [] : message(prompt)),
    send: message,

    interrupt() {
      interrupting = `${prefix}-${++next}`;
      return [line({ type: "control_request", request_id: interrupting, request: { subtype: "interrupt" } })];
    },

    answer(ask, answers) {
      const input = (ask.input && typeof ask.input === "object" ? ask.input : {}) as Record<string, unknown>;
      return [reply(ask.id, { behavior: "allow", updatedInput: { ...input, answers } })];
    },

    decline(ask, reason) {
      return [reply(ask.id, { behavior: "deny", message: reason })];
    },

    read(raw) {
      const trimmed = raw.trim();
      /**
       * A cheap look before parsing, since every streamed token is a
       * line. By content, not position: Claude Code puts `type` near the
       * end of a result line (it opens with "duration_api_ms"), and a
       * check on the prefix never saw the interrupted turn end.
       */
      if (trimmed.includes('"subtype":"init"') && trimmed.includes('"type":"system"')) {
        waitingForTurn = 0;
        return { write: [] };
      }
      if (!trimmed.includes('"type":"control_') && !(interrupting && trimmed.includes('"type":"result"'))) {
        return { write: [] };
      }
      let parsed: ClaudeControlLine;
      try {
        parsed = JSON.parse(trimmed) as ClaudeControlLine;
      } catch {
        return { write: [] };
      }
      switch (parsed.type) {
        case "control_request": {
          const request = parsed.request ?? {};
          const id = parsed.request_id;
          if (typeof id !== "string") return { write: [], events: [] };
          if (request.subtype !== "can_use_tool") {
            // Nothing else is expected of this side; an answer, even a
            // refusal, keeps the CLI from waiting on it.
            return {
              write: [line({ type: "control_response", response: { subtype: "error", request_id: id, error: `Bento does not handle ${String(request.subtype)}` } })],
              events: [],
            };
          }
          if (request.tool_name === "AskUserQuestion") {
            const questions = readAskQuestions(request.input);
            if (questions.length > 0) return { write: [], events: [], asks: [{ id, questions, input: request.input }] };
            return { write: [reply(id, { behavior: "deny", message: "The question could not be shown to anyone." })], events: [] };
          }
          // Any other tool that asks: allowed, as --dangerously-skip-permissions
          // allows it everywhere else. The sandbox is the boundary.
          return { write: [reply(id, { behavior: "allow", updatedInput: request.input ?? {} })], events: [] };
        }
        case "control_cancel_request":
          return typeof parsed.request_id === "string" ? { write: [], events: [], withdrawn: [parsed.request_id] } : { write: [], events: [] };
        case "control_response":
          // The answer to our interrupt. A refusal means no turn was cut
          // short, so the next turn's end is read as it was; otherwise
          // the turn's end says the rest.
          if (parsed.response?.subtype === "error" && parsed.response.request_id === interrupting) interrupting = null;
          return { write: [], events: [] };
        case "result": {
          interrupting = null;
          /**
           * Only the interrupt's own ending is an interrupted turn. A turn
           * that finished first (is_error false), or failed for its own
           * reason (a turn limit, an API error) as the interrupt arrived,
           * is read as the adapter always reads it, so a real failure is
           * never reported as the person's stop.
           */
          if (parsed.is_error === false || parsed.subtype !== "error_during_execution") return { write: [] };
          const ended: AgentEvent = {
            type: "result",
            ok: false,
            interrupted: true,
            error: "Interrupted.",
            raw: parsed,
          };
          if (typeof parsed.session_id === "string") ended.sessionId = parsed.session_id;
          if (typeof parsed.total_cost_usd === "number") ended.costUsd = parsed.total_cost_usd;
          return { write: [], events: [ended] };
        }
        default:
          return { write: [] };
      }
    },
  };
}

/** One stdin line delivering a user message. */
export function encodeClaudeMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

interface ClaudeControlLine {
  type?: string;
  request_id?: unknown;
  request?: { subtype?: unknown; tool_name?: unknown; input?: unknown };
  response?: { subtype?: unknown; request_id?: unknown };
  subtype?: unknown;
  is_error?: boolean;
  session_id?: unknown;
  total_cost_usd?: unknown;
}
