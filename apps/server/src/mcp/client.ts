import { safeFetch, SafeFetchRefused, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * The one MCP request Bento makes outside the run gateway: an
 * initialize handshake used to validate a server and its credential
 * before anything is stored, the way the Linear route calls viewer()
 * before keeping an API key.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** How an API key travels upstream: the Authorization convention gets a Bearer prefix. */
export function credentialHeader(headerName: string, secret: string): { name: string; value: string } {
  if (headerName.toLowerCase() === "authorization") {
    return { name: "Authorization", value: `Bearer ${secret}` };
  }
  return { name: headerName, value: secret };
}

export interface McpPingTarget {
  url: string;
  transport: "http" | "sse";
  apiKeyHeader: string;
}

export type McpPingResult =
  | { ok: true; serverName: string | null }
  | { ok: false; error: string };

const PING_TIMEOUT_MS = 15_000;
const PING_BODY_LIMIT = 64 * 1024;

export async function pingMcpServer(
  target: McpPingTarget,
  secret: string | null,
  policy: SafeFetchPolicy,
): Promise<McpPingResult> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (secret) {
    const header = credentialHeader(target.apiKeyHeader, secret);
    headers[header.name] = header.value;
  }

  const signal = AbortSignal.timeout(PING_TIMEOUT_MS);
  try {
    if (target.transport === "sse") {
      // An sse-transport server answers its stream URL with an event
      // stream; the endpoint event arrives on it, so a content type
      // check is the whole handshake.
      const response = await safeFetch(target.url, { headers: { ...headers, accept: "text/event-stream" }, signal, headersTimeoutMs: PING_TIMEOUT_MS }, policy);
      const type = response.headers.get("content-type") ?? "";
      response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "this server rejected the credential" };
      }
      if (!response.ok || !type.includes("text/event-stream")) {
        return { ok: false, error: "this URL did not answer as an SSE MCP server" };
      }
      return { ok: true, serverName: null };
    }

    const response = await safeFetch(
      target.url,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "Bento", version: "1.0" },
          },
        }),
        signal,
        headersTimeoutMs: PING_TIMEOUT_MS,
      },
      policy,
    );
    if (response.status === 401 || response.status === 403) {
      response.body?.cancel().catch(() => {});
      return { ok: false, error: "this server rejected the credential" };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return { ok: false, error: `this server answered ${response.status} to an initialize request` };
    }
    const message = await readInitializeResult(response);
    if (!message || typeof message !== "object" || !("result" in message)) {
      return { ok: false, error: "this URL did not answer as an MCP server" };
    }
    const result = (message as { result?: { serverInfo?: { name?: unknown } } }).result;
    const name = result?.serverInfo?.name;
    return { ok: true, serverName: typeof name === "string" ? name : null };
  } catch (err) {
    if (err instanceof SafeFetchRefused) return { ok: false, error: err.message };
    return { ok: false, error: "this server did not answer" };
  }
}

/** Streamable HTTP answers either plain JSON or a one-event SSE stream. */
async function readInitializeResult(response: import("undici").Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  const text = await readCapped(response, PING_BODY_LIMIT);
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readCapped(response: import("undici").Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text.slice(0, limit);
}
