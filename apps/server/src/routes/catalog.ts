import { Hono } from "hono";
import { MODEL_CATALOG } from "@bento/core";

/**
 * The provider and model choices, served rather than bundled.
 *
 * Serving it keeps one source of truth: refreshing the snapshot updates
 * every client at once.
 *
 * Public on purpose. This is a list of model names, identical for every
 * tenant, and holding it behind auth would only mean a sign-in before a
 * person can see which models exist.
 *
 * The catalog carries list prices as well as names. A daily job refetches
 * models.dev and the AI Gateway and serves that list; until a fetch has
 * succeeded, and whenever a fetch is refused, this is the committed
 * snapshot. Prices are dollars per million tokens, exactly as models.dev publishes them and
 * as every provider quotes them. They are public for the same reason
 * the names are: a published price is not anybody's secret.
 */
export function catalogRoutes() {
  return new Hono()
    .get("/models", (c) => c.json(MODEL_CATALOG));
}
