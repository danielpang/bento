import type { AgentDelta, AgentEvent } from "@bento/core";
import type { AgentAdapter } from "./adapter.js";

export interface ExecChunk {
  kind: "stdout" | "stderr" | "exit";
  data?: string;
  exitCode?: number;
}

export interface RunAgentInput {
  adapter: AgentAdapter;
  argv: string[];
  /** Yields the process output, whichever sandbox it runs in. */
  exec: () => AsyncIterable<ExecChunk>;
  /** Called for each parsed event, for persistence or streaming. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /**
   * Called for each streaming fragment of the message being composed.
   * Fragments are display-only: they are never collected, persisted,
   * or considered by extractOutcome, so this is synchronous on
   * purpose. A consumer that needs durability wants onEvent.
   */
  onDelta?: (delta: AgentDelta) => void;
}

export interface RunAgentResult {
  events: AgentEvent[];
  exitCode: number;
  outcome: ReturnType<AgentAdapter["extractOutcome"]>;
}

/**
 * Drives one agent process: reads its output line by line, parses each
 * line into an event, and derives the run's outcome.
 *
 * Shared because agents run in two places with the same semantics: the
 * server's orchestrator, and a local runner executing work a server
 * holds. Keeping one copy means a parsing fix cannot land in one and be
 * missed in the other.
 *
 * Buffering matters here: adapters emit newline-delimited JSON and a
 * chunk boundary can fall mid-line, so lines are only parsed once
 * complete, with any trailing partial line parsed at the end.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { adapter, exec, onEvent, onDelta } = input;
  const events: AgentEvent[] = [];
  let buffer = "";
  let exitCode = -1;
  /**
   * Whatever the process said outside the event stream: stderr, and
   * stdout lines that parse as nothing. Usually noise, but when a CLI
   * dies before emitting events it is the only place the reason lives.
   * "claude refuses this flag as root" spent weeks as an unreadable
   * "stopped before reporting a result" because this was discarded.
   */
  let tail = "";
  const keep = (text: string) => {
    tail = (tail + " " + text.replaceAll(/\s+/g, " ").trim()).trimStart().slice(-600);
  };

  // One session-start marker per run. claude-code, codex, cursor, and
  // pi each emit it once and pass straight through; opencode emits a
  // step_start before every agent loop step (each tool call and the
  // final answer), so without collapsing, a 2-tool run printed
  // "[session started]" three times. extractOutcome already takes the
  // first init via events.find, so dropping the rest is safe for every
  // adapter.
  let initialized = false;

  /**
   * Where each channel's current message stands, so every forwarded
   * fragment carries its offset. Adapters see one line at a time; only
   * this loop sees enough of the stream to count. Reset when a message
   * arrives, because that is when composition starts over.
   */
  const streamed = { text: 0, thinking: 0 };

  const emit = async (line: string) => {
    /**
     * Deltas first, and unconditionally: a per token line is neither a
     * transcript event nor stray output, and before this check pi's
     * message_update lines fell through parseEvent into the stderr
     * tail, so a failing run's "reason" was a page of token JSON.
     */
    const fragment = adapter.parseDelta?.(line);
    if (fragment) {
      onDelta?.({ ...fragment, offset: streamed[fragment.channel] });
      streamed[fragment.channel] += fragment.text.length;
      return;
    }
    const event = adapter.parseEvent(line);
    if (!event) {
      if (line.trim()) keep(line);
      return;
    }
    if (event.type === "init" && initialized) return;
    if (event.type === "init") initialized = true;
    if (event.type === "message" || event.type === "result") {
      streamed.text = 0;
      streamed.thinking = 0;
    }
    events.push(event);
    await onEvent?.(event);
  };

  for await (const chunk of exec()) {
    if (chunk.kind === "exit") {
      exitCode = chunk.exitCode ?? -1;
      break;
    }
    if (chunk.kind === "stderr") {
      if (chunk.data?.trim()) keep(chunk.data);
      continue;
    }

    buffer += chunk.data ?? "";
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await emit(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) await emit(buffer);

  const outcome = adapter.extractOutcome(events, exitCode);
  // Only when the agent never got to explain itself: an agent that
  // reported a result already said what went wrong in it. A result
  // that itself points at logs ("check server logs") has not explained
  // anything either; opencode wraps every internal failure that way,
  // and the actual reason is in the stderr tail.
  const explained = events.some((event) => event.type === "result");
  const unexplained = !explained || /check server logs/i.test(outcome.error ?? "");
  if (!outcome.ok && unexplained && tail) {
    return { events, exitCode, outcome: { ...outcome, error: `${outcome.error ?? "failed"}: ${tail}` } };
  }
  return { events, exitCode, outcome };
}
