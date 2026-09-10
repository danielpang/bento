import { readFileSync } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

/**
 * The console's shell, and the build id stamped into it.
 *
 * Read once at boot rather than per request, because the id has to be
 * the id of the bytes being served: a shell read fresh each time and
 * a build id cached separately could disagree the moment somebody
 * replaced the directory under a running server. One read gives both,
 * so they cannot.
 *
 * The header goes on every API response and the id into /api/health.
 * The console compares it with the id its own page carries, and a
 * mismatch is how a tab left open across a deploy learns to reload,
 * before its next lazy chunk turns out to be a file the new image
 * does not have. The tag comes from the Vite build (apps/web/src/
 * build-id.ts); a shell without one, an older build for instance,
 * serves fine and simply sends no header.
 */
export const BUILD_HEADER = "x-bento-build";

export interface WebShell {
  html: string;
  build: string | null;
}

const BUILD_META_TAG = /<meta\b[^>]*\bname="bento-build"[^>]*>/;
const CONTENT = /\bcontent="([^"]*)"/;

/** The id the shell claims, or null when it carries none. */
export function readBuildId(html: string): string | null {
  const tag = BUILD_META_TAG.exec(html)?.[0];
  if (!tag) return null;
  const id = CONTENT.exec(tag)?.[1]?.trim();
  return id || null;
}

/** Null when the directory has no index.html: nothing to serve, no id to send. */
export function loadWebShell(webDir: string): WebShell | null {
  let html: string;
  try {
    html = readFileSync(path.join(webDir, "index.html"), "utf8");
  } catch {
    return null;
  }
  return { html, build: readBuildId(html) };
}

/**
 * Static files under `root`, with one Cache-Control value on every hit.
 *
 * Not serveStatic's own `onFound`: that hook runs after the response
 * has been built, so a header set there through `c.header()` lands in
 * a bucket the response no longer reads. The console's assets and
 * icons shipped with no cache header at all that way, immutable in
 * intent and revalidated on every load in practice. The header goes
 * on the response the middleware actually returns; a miss returns the
 * chain's result instead, and that is left alone so the shell behind
 * it keeps its own rules.
 */
export function cachedStatic(root: string, cacheControl: string): MiddlewareHandler {
  const serve = serveStatic({ root });
  return async (c, next) => {
    const res = await serve(c, next);
    if (res instanceof Response) res.headers.set("cache-control", cacheControl);
    return res;
  };
}
