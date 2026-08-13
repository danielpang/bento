import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { getAccessibleArtifact } from "../access.js";

/**
 * Serves one run artifact: metadata, and the bytes.
 *
 * Authorization is the run_artifacts row, reached through the same
 * access helper and 404 convention as every other entity route. The
 * store key never appears in a response and is never taken from the
 * request, so the bucket's layout is not part of the API.
 *
 * Every byte here was written by an agent, and agents ingest untrusted
 * input, so the content route treats its own answers as hostile:
 * nosniff, a sandboxing CSP, and inline rendering only for content
 * types that cannot carry script. The console renders HTML artifacts
 * inside a sandboxed iframe via srcdoc; navigating to this route
 * directly downloads them instead of rendering on the app's origin.
 */

/** Types a browser may render at this URL: raster images and plain text. */
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown"]);

/** The artifact's own filename, defanged for a header it travels inside. */
function headerSafeName(path: string): string {
  const base = path.split("/").pop() ?? "artifact";
  const safe = base.replaceAll(/[^\w.-]/g, "_");
  return safe || "artifact";
}

export function artifactRoutes(ctx: AppContext) {
  return new Hono()
    .get("/:id", async (c) => {
      const artifact = await getAccessibleArtifact(ctx, c, c.req.param("id"));
      if (!artifact) return c.json({ error: "not found" }, 404);
      // The store key is bookkeeping between the server and its bucket.
      const { storageKey: _storageKey, ...row } = artifact;
      return c.json(row);
    })
    .get("/:id/content", async (c) => {
      const artifact = await getAccessibleArtifact(ctx, c, c.req.param("id"));
      if (!artifact) return c.json({ error: "not found" }, 404);

      // Artifacts are immutable, so the id is the strongest ETag there is.
      const etag = `"${artifact.id}"`;
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);

      let body: Buffer | null = artifact.content !== null ? Buffer.from(artifact.content, "utf8") : null;
      if (body === null && artifact.storageKey) {
        if (!ctx.artifacts) {
          return c.json({ error: "this deployment has no artifact storage configured" }, 503);
        }
        body = await ctx.artifacts.get(artifact.storageKey);
      }
      // The row outlived its bytes, which is a true answer, not an error
      // to dress up: the object was removed from the store.
      if (body === null) return c.json({ error: "not found" }, 404);

      c.header("content-type", artifact.mime);
      c.header("x-content-type-options", "nosniff");
      // Even navigated to directly, the response runs no script and has
      // an opaque origin: an artifact must never act as this app.
      c.header("content-security-policy", "sandbox");
      c.header("cache-control", "private, max-age=3600");
      c.header("etag", etag);
      const mode = INLINE_MIMES.has(artifact.mime) ? "inline" : "attachment";
      c.header("content-disposition", `${mode}; filename="${headerSafeName(artifact.path)}"`);
      return c.body(new Uint8Array(body));
    });
}
