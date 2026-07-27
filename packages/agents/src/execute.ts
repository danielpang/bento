import type { AgentEvent } from "@bento/core";
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
  const { adapter, exec, onEvent } = input;
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

  const emit = async (line: string) => {
    const event = adapter.parseEvent(line);
    if (!event) {
      if (line.trim()) keep(line);
      return;
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
