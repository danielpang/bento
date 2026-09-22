import { Hono, type Context } from "hono";
import type { runArtifacts } from "@bento/db";
import type { AppContext } from "../context.js";
import { getAccessibleArtifact, getAccessibleSwarmArtifact } from "../access.js";
import { artifactPreviewPage, ARTIFACT_PREVIEW_POLICY } from "../artifact-preview.js";
import { requireSwarms } from "../orchestrator/swarm/gate.js";

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
 *
 * Both boards' artifacts are served here, and each is resolved through
 * its own helper. A card's goes through a feature; a swarm's goes
 * through its swarm and then through the beta gate, so a person who
 * cannot see that swarms exist cannot learn it from an artifact id.
 * One helper that accepted either would be a helper that had quietly
 * widened, which is the shape this file's rule exists to prevent.
 */

/** Types a browser may render at this URL: raster images and plain text. */
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown"]);

/** The artifact's own filename, defanged for a header it travels inside. */
function headerSafeName(path: string): string {
  const base = path.split("/").pop() ?? "artifact";
  const safe = base.replaceAll(/[^\w.-]/g, "_");
  return safe || "artifact";
}


/**
 * One artifact, from whichever board it belongs to, or null.
 *
 * The card's is tried first because it is the common one, and neither
 * answer tells the caller which was asked: every refusal here is the
 * same 404 the access helpers give, so an id belonging to somebody
 * else's swarm and an id belonging to nothing read alike.
 */
async function resolveArtifact(
  ctx: AppContext,
  c: Context,
): Promise<typeof runArtifacts.$inferSelect | null> {
  const id = c.req.param("id") ?? "";
  const card = await getAccessibleArtifact(ctx, c, id);
  if (card) return card;
  const swarm = await getAccessibleSwarmArtifact(ctx, c, id);
  if (!swarm) return null;
  // The same gate every swarm route asks, about the swarm's own team.
  return (await requireSwarms(ctx, c, swarm.swarm.organizationId)) ? null : swarm.artifact;
}

export function artifactRoutes(ctx: AppContext) {
  return new Hono()
    .get("/:id/preview", async (c) => {
      const artifact = await resolveArtifact(ctx, c);
      if (!artifact) return c.json({ error: "not found" }, 404);
      let bytes: Buffer | null = artifact.content !== null ? Buffer.from(artifact.content, "utf8") : null;
      if (bytes === null && artifact.storageKey) {
        if (!ctx.artifacts) return c.json({ error: "this deployment has no artifact storage configured" }, 503);
        bytes = await ctx.artifacts.get(artifact.storageKey);
      }
      if (bytes === null) return c.json({ error: "not found" }, 404);
      c.header("content-security-policy", ARTIFACT_PREVIEW_POLICY);
      c.header("x-content-type-options", "nosniff");
      c.header("referrer-policy", "no-referrer");
      c.header("cache-control", "no-store");
      return c.html(artifactPreviewPage(artifact, bytes));
    })
    .get("/:id", async (c) => {
      const artifact = await resolveArtifact(ctx, c);
      if (!artifact) return c.json({ error: "not found" }, 404);
      // Stated column by column rather than by subtraction, so a column
      // added to run_artifacts later has to be put here on purpose. The
      // store key stays out (bookkeeping between the server and its
      // bucket); inline content rides along because for text artifacts
      // it is the useful half of the answer. The type and the swarm are
      // in, now that both boards are served here: a client that asked
      // for an id has to be able to tell what it got back.
      const { id, runId, featureId, swarmId, swarmTaskId, type, stageSlug, stageName, path, kind, mime, size, content, createdAt } =
        artifact;
      return c.json({
        id,
        runId,
        featureId,
        swarmId,
        swarmTaskId,
        type,
        stageSlug,
        stageName,
        path,
        kind,
        mime,
        size,
        content,
        createdAt,
      });
    })
    /**
     * Deliberately inside the tenant transaction, store fetch and all,
     * unlike the /events routes. Their exclusion exists for connections
     * held the length of an agent run; this hold is bounded by one
     * capped object read (25 MB, usually far less), the same class of
     * in-request work /changes does when it shells out to git. Keeping
     * the route wrapped keeps row-level security on it, and the layers
     * are not interchangeable: do not move it out to shave the hold.
     */
    .get("/:id/content", async (c) => {
      const artifact = await resolveArtifact(ctx, c);
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
