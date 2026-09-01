import { MCP_PROTOCOL_VERSION } from "./client.js";
import { parseResourceMetadata } from "./discovery.js";
import { safeFetch, type SafeFetchPolicy } from "./safe-fetch.js";

/**
 * What a server wants before it will talk: nothing, a sign in, or a key.
 *
 * Asking a person to classify a server they have not connected yet is
 * asking them to guess. The server itself knows, and says so on an
 * unauthenticated request: a 401 carrying RFC 9728 resource metadata
 * means OAuth, a plain refusal means it wants a key, and an answer
 * means it wants nothing. So the console offers one button and this
 * decides, rather than offering a menu of auth types.
 *
 * Wrong guesses are recoverable: the auth type is editable afterwards,
 * and an OAuth connect that finds no authorization server says so.
 */

const PROBE_TIMEOUT_MS = 8_000;

export type DetectedAuth = "none" | "api_key" | "oauth";

export async function detectAuthType(
  url: string,
  transport: "http" | "sse",
  policy: SafeFetchPolicy,
): Promise<DetectedAuth> {
  try {
    const response =
      transport === "sse"
        ? await safeFetch(
            url,
            { headers: { accept: "text/event-stream" }, headersTimeoutMs: PROBE_TIMEOUT_MS },
            policy,
          )
        : await safeFetch(
            url,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              },
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
              headersTimeoutMs: PROBE_TIMEOUT_MS,
            },
            policy,
          );

    const challenge = response.headers.get("www-authenticate") ?? "";
    response.body?.cancel().catch(() => {});

    if (response.status === 401 || response.status === 403) {
      // The spec's own signal: a challenge pointing at resource
      // metadata is an OAuth server saying so.
      if (parseResourceMetadata(challenge)) return "oauth";
      if (/bearer/i.test(challenge)) return "oauth";
      return "api_key";
    }
    if (response.ok) return "none";
    // Some servers answer an unauthenticated initialize with a plain
    // error rather than a 401. A key is the safer assumption: it asks
    // for something rather than silently attaching nothing.
    return "api_key";
  } catch {
    // Unreachable right now says nothing about how it authenticates.
    // A key is the recoverable default; the person can change it.
    return "api_key";
  }
}
