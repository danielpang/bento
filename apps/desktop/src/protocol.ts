import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Session } from "electron";
import { proxyApiStream, shouldProxyApiStream } from "./http-proxy.js";
import { assetPath, canProxyApi, isApiPath, isConsolePage } from "./security.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

export async function bundledFile(root: string, pathname: string, shell = false): Promise<Response> {
  const file = assetPath(root, shell ? "/index.html" : pathname);
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(file);
    const hashes = shell ? [...bytes.toString("utf8").matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`).join(" ") : "";
    return new Response(bytes, { headers: {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      ...(shell ? {
        "content-security-policy": `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https:; frame-src 'self' bento-preview: about: blob: data:; media-src 'self' blob: data: https:; object-src 'none'; base-uri 'self'`,
      } : {}),
    } });
  } catch { return new Response("Not found", { status: 404 }); }
}

/** Serve the installed console at its real API origin, preserving all web URLs. */
export async function installConsoleProtocol(options: {
  session: Session;
  origin: string;
  webDirectory: string;
  token(): string | null;
  signedOut(): Promise<void>;
}): Promise<void> {
  const { session, origin, webDirectory } = options;
  if (session.protocol.isProtocolHandled("bento-preview")) session.protocol.unhandle("bento-preview");
  session.protocol.handle("bento-preview", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "artifact" || url.pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(PREVIEW_DOCUMENT, { headers: {
      "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff",
      // This document has no preload, credentials, or privileged origin. Its
      // nested srcdoc keeps arbitrary artifact scripts out of the console's CSP.
      "content-security-policy": "sandbox allow-scripts; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'",
    } });
  });
  const scheme = new URL(origin).protocol.slice(0, -1);
  if (session.protocol.isProtocolHandled(scheme)) session.protocol.unhandle(scheme);
  session.protocol.handle(scheme, async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin) return session.fetch(request, { bypassCustomProtocolHandlers: true });
    if (!isApiPath(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return bundledFile(webDirectory, url.pathname, isConsolePage(url.pathname));
    }
    if (!canProxyApi((request as Request & { initiatorOrigin?: string }).initiatorOrigin, origin)) return new Response("Forbidden", { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("authorization");
    headers.delete("cookie");
    const token = options.token();
    if (token) headers.set("authorization", `Bearer ${token}`);
    // Requests originate in the bundled console at this exact origin. Keep
    // better-auth's CSRF checks enabled, including its trusted origin check.
    headers.set("origin", origin);
    try {
      // HTTP event streams go through Node. session.fetch keeps an aborted
      // HTTP stream open, and a reload then fills Chromium's per-host
      // connection cap until the board's next requests never complete.
      const response = shouldProxyApiStream(request.method, url, headers)
        ? await proxyApiStream(new Request(request.url, { method: request.method, headers, signal: request.signal }))
        : await session.fetch(request.url, {
          method: request.method, headers, redirect: "manual", credentials: "omit",
          bypassCustomProtocolHandlers: true, signal: request.signal,
          ...(request.method !== "GET" && request.method !== "HEAD" ? { body: await request.arrayBuffer() } : {}),
        });
      if (url.pathname === "/api/auth/sign-out" && response.ok) await options.signedOut();
      const outgoing = new Headers(response.headers);
      // The installed console updates with the desktop release. Comparing it
      // with a separately deployed web build would create an endless reload toast.
      outgoing.delete("x-bento-build");
      outgoing.delete("set-cookie");
      outgoing.delete("content-encoding");
      outgoing.delete("content-length");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      return Response.json({ error: "Cannot reach the Bento server. Check your connection and try again." }, { status: 502 });
    }
  });
}

const PREVIEW_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style></head><body><iframe sandbox="allow-scripts" title="Artifact preview"></iframe><script>
addEventListener('message', event => {
  if (event.source !== parent || !event.data || typeof event.data.html !== 'string') return;
  document.querySelector('iframe').srcdoc = event.data.html;
});
</script></body></html>`;
