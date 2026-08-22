import type { CatalogProvider } from "./models.js";

/**
 * Providers and ids the generated snapshot cannot supply.
 *
 * `model-catalog.generated.ts` is rebuilt from models.dev. That source
 * now describes xAI, so Grok for the Cursor CLI comes from there (billed
 * through CURSOR_API_KEY). It still has no Cursor provider: Composer is
 * only served inside Cursor, so the ids the CLI takes on --model are
 * described nowhere the generator looks. Nor does it have a Poolside
 * provider: it lists Laguna under OpenRouter, which is a different
 * endpoint, a different key and different ids from Poolside's own
 * inference. Those are the entries here.
 *
 * Kept in a separate file because `pnpm models:update` overwrites the
 * generated one wholesale. Anything added there by hand disappears the
 * next time somebody refreshes the snapshot.
 *
 * If models.dev later grows either provider, the generator will pick it
 * up and these ids merge on top: already-listed ones stay put, Auto and
 * any Composer or Laguna variant the snapshot missed still appear.
 *
 * These lists are hand maintained and go stale. That is survivable: what
 * a tool can run is checked against the catalog only to refuse a pairing
 * no provider serves, and a model the catalog has never heard of stays
 * typeable. See checkAgentPairing.
 *
 * The Mac app draws no mark for these providers yet. It reads its marks
 * as PNGs rendered by scripts/render-provider-logos.mjs, which needs a
 * mac to run, and logoIdFor() in apps/mac/src/wire.ts answers zero for
 * any provider whose renditions are not registered yet. Zero is drawn as
 * nothing, so the agent still lists and runs; only the logo is missing.
 */
export const MANUAL_CATALOG: readonly CatalogProvider[] = [
  {
    id: "cursor",
    name: "Cursor",
    env: ["CURSOR_API_KEY"],
    logo: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBvbHlnb24gcG9pbnRzPSIyMCw0LjAyIDMzLjIsMTEuNSAyMCwxOC45OCA2LjgsMTEuNSIgZmlsbD0iY3VycmVudENvbG9yIi8+Cjxwb2x5Z29uIHBvaW50cz0iNS45LDEzLjAzIDE5LjEsMjAuNTEgMTkuMSwzNS40NyA1LjksMjcuOTkiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8cG9seWdvbiBwb2ludHM9IjIwLjksMjAuNTEgMzQuMSwxMy4wMyAzNC4xLDI3Ljk5IDIwLjksMzUuNDciIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K",
    // Cursor's own models. The CLI takes these as bare ids on --model.
    // Auto is a router rather than a model: it picks per request, which
    // is what most Cursor plans default to. Newest Composer first, so
    // the picker does not bury the current ones behind Composer 1.
    models: [
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
      { id: "composer-2", name: "Composer 2" },
      { id: "composer-2-fast", name: "Composer 2 Fast" },
      { id: "composer-1", name: "Composer 1" },
      { id: "auto", name: "Auto (Cursor picks per request)" },
    ],
  },
  {
    id: "poolside",
    name: "Poolside",
    env: ["POOLSIDE_API_KEY"],
    // No mark: there is none in the repository, and inventing a brand
    // mark is worse than the empty slot ProviderMark already draws for
    // a provider without one.
    logo: "",
    /**
     * Laguna, as Poolside's own inference serves it. The generated
     * snapshot carries these weights under OpenRouter, with the
     * routing suffixes that source uses (":free"); those belong to
     * OpenRouter and not here, so this provider is its own entry
     * rather than ids appended to that one.
     *
     * One model, because one is what is published. Poolside supports
     * Laguna S 2.1, XS 2.1 and M.1, but only `poolside/laguna-s-2.1`
     * appears as an id anywhere Poolside documents, and
     * https://inference.poolside.ai/v1/models needs a key to read. The
     * other two are reachable today by typing the id; they join this
     * list when someone with a key has read them back, rather than
     * from a guess at the naming pattern that puts a broken default in
     * front of everybody.
     */
    models: [{ id: "poolside/laguna-s-2.1", name: "Laguna S 2.1" }],
  },
];
