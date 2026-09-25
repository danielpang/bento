import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

const DROPPED_REQUEST_HEADERS = new Set(["host", "content-length", "accept-encoding", "connection", "keep-alive", "transfer-encoding", "upgrade"]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "content-encoding", "content-length", "set-cookie", "x-bento-build",
]);

/**
 * Board and run streams. Chromium caps a host at six HTTP/1.1 sockets.
 * `session.fetch` does not close an HTTP event stream when the page
 * reloads, so Command-R leaves the old stream occupying a socket and the
 * reloaded board's API calls never leave the pending state.
 *
 * Only plain HTTP GET and HEAD take this path. HTTPS stays on Chromium so
 * a remote server still uses the system proxy and certificate store. A
 * POST whose path happens to end in `/events` carries a body this proxy
 * does not forward, so it stays on `session.fetch` too.
 */
export function isLongLivedApiStream(url: URL, headers: Headers): boolean {
  return url.pathname.endsWith("/events") || (headers.get("accept") ?? "").includes("text/event-stream");
}

export function shouldProxyApiStream(method: string, url: URL, headers: Headers): boolean {
  return (method === "GET" || method === "HEAD") && url.protocol === "http:" && isLongLivedApiStream(url, headers);
}

/**
 * Forwards one API stream on a Node socket that is not part of Chromium's
 * pool. Aborting the request, or cancelling the body, destroys that socket
 * so the server sees the client leave.
 */
export function proxyApiStream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error(`Cannot proxy ${url.protocol} streams`));
  }
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!DROPPED_REQUEST_HEADERS.has(key)) headers[key] = value;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let upstream: ReturnType<typeof httpRequest> | undefined;
    const onAbort = () => {
      upstream?.destroy();
      if (!settled) fail(new DOMException("The operation was aborted.", "AbortError"));
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      if (request.signal.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
      else reject(error instanceof Error ? error : new Error(String(error)));
    };
    const options: RequestOptions = { method: request.method, headers, agent: false };
    upstream = transport(url, options, (incoming) => {
      const current = upstream;
      if (settled || !current) {
        incoming.destroy();
        current?.destroy();
        return;
      }
      settled = true;
      resolve(streamResponse(current, incoming, () => request.signal.removeEventListener("abort", onAbort)));
    });
    // Attached before any abort path can destroy the socket. An error with
    // no listener is thrown by Node, not returned to the caller.
    upstream.on("error", fail);
    if (request.signal.aborted) {
      onAbort();
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
    upstream.end();
  });
}

function streamResponse(
  upstream: ReturnType<typeof httpRequest>,
  incoming: IncomingMessage,
  onDone: () => void,
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(key)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    onDone();
    incoming.destroy();
    upstream.destroy();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on("data", (chunk: Buffer) => {
        if (stopped) return;
        try { controller.enqueue(new Uint8Array(chunk)); }
        catch { stop(); }
      });
      incoming.on("end", () => {
        onDone();
        if (stopped) return;
        stopped = true;
        try { controller.close(); } catch { /* already cancelled */ }
      });
      incoming.on("error", (error) => {
        onDone();
        if (stopped) return;
        stopped = true;
        incoming.destroy();
        upstream.destroy();
        try { controller.error(error); } catch { /* already cancelled */ }
      });
    },
    cancel() { stop(); },
  });
  return new Response(body, {
    status: incoming.statusCode ?? 502,
    statusText: incoming.statusMessage ?? "",
    headers,
  });
}
