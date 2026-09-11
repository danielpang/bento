import { readFileSync } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { BUILD_ID, BUILD_META } from "@bento/core";

export { BUILD_HEADER } from "@bento/core";

const BUILD_META_TAG = new RegExp(`<meta\\b[^>]*\\bname="${BUILD_META}"[^>]*>`);
const CONTENT = /\bcontent="([^"]*)"/;

export function readBuildId(html: string): string | null {
  const tag = BUILD_META_TAG.exec(html)?.[0];
  const id = tag ? CONTENT.exec(tag)?.[1]?.trim() : undefined;
  return id && BUILD_ID.test(id) ? id : null;
}

export interface WebShell {
  /** The id of the shell most recently read; null before the first read or without a stamp. */
  readonly build: string | null;
  /** Reads index.html; null when it is missing. Each read refreshes `build`. */
  load(): { html: string; build: string | null } | null;
}

/**
 * The console's shell (apps/web/dist/index.html) and the build id the
 * Vite build stamped into it. Read per shell request, so a rebuild
 * under a running server takes effect; `build` follows the last read,
 * so the header can never name a shell other than the one served.
 */
export function createWebShell(webDir: string): WebShell {
  const file = path.join(webDir, "index.html");
  let build: string | null = null;
  return {
    get build() {
      return build;
    },
    load() {
      let html: string;
      try {
        html = readFileSync(file, "utf8");
      } catch {
        return null;
      }
      build = readBuildId(html);
      return { html, build };
    },
  };
}

/**
 * serveStatic builds its response before calling onFound, so a header
 * set there with c.header() is lost (assets and icons used to ship
 * with no cache header). Set it on the response the middleware
 * returns; a miss returns the chain's result and is left alone.
 */
export function cachedStatic(root: string, cacheControl: string): MiddlewareHandler {
  const serve = serveStatic({ root });
  return async (c, next) => {
    const res = await serve(c, next);
    if (res instanceof Response) res.headers.set("cache-control", cacheControl);
    return res;
  };
}
