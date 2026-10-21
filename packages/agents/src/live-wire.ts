import type { BuildCommandInput, LiveProtocol, LiveSession } from "./adapter.js";

/**
 * The live session of one process, whichever shape its tool speaks.
 *
 * The executor and the live conversation only ever talk to this. A tool
 * that reads one line per message (Claude Code, pi) is wrapped into the
 * same four methods a JSON-RPC protocol implements, so neither caller
 * has to know which kind of process it is feeding.
 */
export type LiveWire = LiveProtocol;

const NOTHING: { write: string[] } = Object.freeze({ write: [] }) as { write: string[] };

export function openLiveWire(live: LiveSession, input: BuildCommandInput, how: { attach: boolean }): LiveWire {
  if (live.connect) return live.connect(input, how);
  const encode = live.encodeMessage;
  if (!encode) throw new Error("a live session must declare encodeMessage or connect");
  return {
    open: (prompt) => (prompt === null ? [] : [encode(prompt, "initial")]),
    send: (text) => [encode(text, "followUp")],
    read: () => NOTHING,
    held: 0,
  };
}

/**
 * One line of a JSON-RPC 2.0 stream, sorted by what it asks of us.
 *
 * Codex's app-server omits the "jsonrpc" member and opencode's ACP
 * server sends it, so its presence decides nothing: an `id` with a
 * `method` is a request to answer, an `id` alone is the answer to one
 * of ours, and a `method` alone is a notification.
 */
export type RpcLine =
  | { kind: "response"; id: string; result?: unknown; error?: { code?: number; message?: string } }
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown };

export function readRpcLine(line: string): RpcLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return null;
  }
  const hasId = typeof parsed.id === "string" || typeof parsed.id === "number";
  if (typeof parsed.method === "string") {
    return hasId
      ? { kind: "request", id: parsed.id as string | number, method: parsed.method, params: parsed.params }
      : { kind: "notification", method: parsed.method, params: parsed.params };
  }
  if (!hasId) return null;
  const response: RpcLine = { kind: "response", id: String(parsed.id) };
  if ("result" in parsed) response.result = parsed.result;
  if (parsed.error && typeof parsed.error === "object") response.error = parsed.error as { code?: number; message?: string };
  return response;
}

/**
 * Request ids and their pending answers, for one process.
 *
 * Ids carry a prefix fresh for every connection. A server that
 * reattaches to a running agent opens a new connection to a process
 * whose last life already used `1`, `2`, `3`, and a replayed answer to
 * one of those must not be taken for the answer to this life's request.
 */
export class RpcCalls<Tag extends string> {
  // Unique, not secret: it only has to differ from the last connection's.
  private readonly prefix = `bento-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private next = 0;
  private readonly pending = new Map<string, Tag>();

  constructor(private readonly jsonrpc: boolean) {}

  request(tag: Tag, method: string, params: unknown): string {
    const id = `${this.prefix}-${++this.next}`;
    this.pending.set(id, tag);
    return this.line({ id, method, params });
  }

  notify(method: string, params?: unknown): string {
    return this.line(params === undefined ? { method } : { method, params });
  }

  reply(id: string | number, result: unknown): string {
    return this.line({ id, result });
  }

  refuse(id: string | number, code: number, message: string): string {
    return this.line({ id, error: { code, message } });
  }

  /** What a response answers, taken off the pending list. Undefined for an id this connection never sent. */
  settle(id: string): Tag | undefined {
    const tag = this.pending.get(id);
    this.pending.delete(id);
    return tag;
  }

  private line(message: Record<string, unknown>): string {
    return JSON.stringify(this.jsonrpc ? { jsonrpc: "2.0", ...message } : message);
  }
}

/** The JSON-RPC code for a method this side does not implement. */
export const METHOD_NOT_FOUND = -32601;
