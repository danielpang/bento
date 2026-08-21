import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointRewriter } from "./mcp-gateway.js";

async function run(serverId: string, upstreamUrl: string, input: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(endpointRewriter(serverId, upstreamUrl));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test("the endpoint event is rewritten to a relative gateway path", async () => {
  const out = await run(
    "srv-1",
    "https://mcp.example.com/sse",
    "event: endpoint\ndata: /messages?sessionId=abc\n\n",
  );
  assert.match(out, /data: \/api\/mcp-gateway\/srv-1\/messages\?sessionId=abc/);
});

test("a message frame after an endpoint frame is not rewritten", async () => {
  // The endpoint event ends at the blank line; the following message
  // frame carries no event: line (defaults to "message") and its data
  // must pass through untouched, not be treated as an endpoint.
  const out = await run(
    "srv-1",
    "https://mcp.example.com/sse",
    [
      "event: endpoint",
      "data: /messages?sessionId=abc",
      "",
      "data: {\"jsonrpc\":\"2.0\",\"result\":\"/not-an-endpoint\"}",
      "",
    ].join("\n"),
  );
  assert.match(out, /data: \/api\/mcp-gateway\/srv-1\/messages/, "the endpoint is rewritten");
  assert.match(
    out,
    /data: \{"jsonrpc":"2.0","result":"\/not-an-endpoint"\}/,
    "the following message data is passed through verbatim",
  );
  assert.ok(!out.includes("/api/mcp-gateway/srv-1//not-an-endpoint"), "the message data was not rewritten as an endpoint");
});

test("an endpoint on a different origin ends the event rather than proxying it", async () => {
  const out = await run(
    "srv-1",
    "https://mcp.example.com/sse",
    "event: endpoint\ndata: https://evil.example.test/messages\n\n",
  );
  assert.ok(!out.includes("evil.example.test"), "an off-origin endpoint is dropped");
  assert.ok(!out.includes("/api/mcp-gateway/srv-1/messages"), "and not rewritten to the gateway");
});
