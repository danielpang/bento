import type { CatalogProvider } from "./models.js";

/**
 * Providers the generated snapshot cannot supply.
 *
 * `model-catalog.generated.ts` is rebuilt from models.dev, and that
 * source only carries providers you reach with your own API key. The
 * Cursor CLI is not one of those: it authenticates with CURSOR_API_KEY
 * and bills every model through the Cursor plan, so the models it offers
 * beyond Claude and GPT are described nowhere the generator looks. Those
 * are the entries here.
 *
 * Kept in a separate file because `pnpm models:update` overwrites the
 * generated one wholesale. Anything added there by hand disappears the
 * next time somebody refreshes the snapshot, and would take Grok and
 * Composer off the picker without a line of the diff saying so.
 *
 * These lists are hand maintained and go stale. That is survivable: what
 * a tool can run is checked against the catalog only to refuse a pairing
 * no provider serves, and a model the catalog has never heard of stays
 * typeable. See checkAgentPairing.
 *
 * The Mac app draws no mark for these two. It reads its marks as PNGs
 * rendered by scripts/render-provider-logos.mjs, which needs a mac to
 * run, and logoIdFor() in apps/mac/src/wire.ts answers zero for any
 * provider whose renditions are not registered yet. Zero is drawn as
 * nothing, so the agent still lists and runs; only the logo is missing.
 */
export const MANUAL_CATALOG: readonly CatalogProvider[] = [
  {
    id: "xai",
    name: "xAI",
    // Bento stores no XAI_API_KEY: Grok is reachable here only through
    // the Cursor CLI, which pays for it with the Cursor key. Adding a
    // direct xAI path means adding that credential to AGENT_CREDENTIALS
    // and listing xai for whichever tool gained it.
    env: ["CURSOR_API_KEY"],
    // Hand drawn, unlike the generated marks, which are fetched from
    // models.dev alongside their models.
    logo: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBvbHlnb24gcG9pbnRzPSI2LDUgMTMsNSAzNCwzNSAyNywzNSIgZmlsbD0iY3VycmVudENvbG9yIi8+Cjxwb2x5Z29uIHBvaW50cz0iMjcsNSAzNCw1IDI2LjMsMTYgMTkuMywxNiIgZmlsbD0iY3VycmVudENvbG9yIi8+Cjxwb2x5Z29uIHBvaW50cz0iMTMuNywyNCAyMC43LDI0IDEzLDM1IDYsMzUiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K",
    // The bare ids Cursor takes, which are the ids OpenRouter serves the
    // same models under with the vendor prefix dropped.
    models: [
      { id: "grok-4.5", name: "Grok 4.5" },
      { id: "grok-4.3", name: "Grok 4.3" },
      { id: "grok-4.20", name: "Grok 4.20" },
      { id: "grok-4.20-multi-agent", name: "Grok 4.20 Multi-Agent" },
      { id: "grok-build-0.1", name: "Grok Build 0.1" },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    env: ["CURSOR_API_KEY"],
    logo: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBvbHlnb24gcG9pbnRzPSIyMCw0LjAyIDMzLjIsMTEuNSAyMCwxOC45OCA2LjgsMTEuNSIgZmlsbD0iY3VycmVudENvbG9yIi8+Cjxwb2x5Z29uIHBvaW50cz0iNS45LDEzLjAzIDE5LjEsMjAuNTEgMTkuMSwzNS40NyA1LjksMjcuOTkiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8cG9seWdvbiBwb2ludHM9IjIwLjksMjAuNTEgMzQuMSwxMy4wMyAzNC4xLDI3Ljk5IDIwLjksMzUuNDciIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K",
    // Cursor's own models. Auto is a router rather than a model: it
    // picks per request, which is what most Cursor plans default to.
    models: [
      { id: "composer-1", name: "Composer 1" },
      { id: "auto", name: "Auto (Cursor picks per request)" },
    ],
  },
];
