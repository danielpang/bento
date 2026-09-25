import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { proxyApiStream, shouldProxyApiStream } from "./http-proxy.js";

test("only HTTP GET and HEAD event streams bypass Chromium", () => {
  const headers = new Headers({ accept: "text/event-stream" });
  const httpEvents = new URL("http://127.0.0.1:4400/api/board/project/events");
  assert.equal(shouldProxyApiStream("GET", httpEvents, headers), true);
  assert.equal(shouldProxyApiStream("HEAD", httpEvents, headers), true);
  assert.equal(shouldProxyApiStream("POST", new URL("http://127.0.0.1:4400/api/runner/runs/1/events"), headers), false);
  assert.equal(shouldProxyApiStream("GET", new URL("https://bento.example/api/board/project/events"), headers), false);
  assert.equal(shouldProxyApiStream("GET", new URL("http://127.0.0.1:4400/api/health"), new Headers()), false);
});

test("aborting a proxied event stream closes the upstream connection", async () => {
  let disconnected = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/api/board/project/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "content-encoding": "identity" });
      response.write("event: board_event\ndata: {}\n\n");
      request.on("close", () => { disconnected = true; });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  try {
    const response = await proxyApiStream(new Request(`${origin}/api/board/project/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("content-encoding"), null);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /board_event/);

    controller.abort();
    const deadline = Date.now() + 2_000;
    while (!disconnected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disconnected, true, "the server must see the reload drop the stream");

    const followUp = await fetch(`${origin}/ok`);
    assert.equal(followUp.status, 200);
    assert.deepEqual(await followUp.json(), { ok: true });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("cancelling the response body closes the upstream connection without aborting the signal", async () => {
  let disconnected = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: board_event\ndata: {}\n\n");
    request.on("close", () => { disconnected = true; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    const response = await proxyApiStream(new Request(`http://127.0.0.1:${address.port}/api/runs/1/events`));
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();
    const deadline = Date.now() + 2_000;
    while (!disconnected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disconnected, true, "dropping the response body must drop the server socket");
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
