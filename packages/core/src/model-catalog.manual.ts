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
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    logo: "data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBmaWxsPSJjdXJyZW50Q29sb3IiIGQ9Ik0yMy43NDggNC42NTFjLS4yNTQtLjEyNC0uMzY0LjExMy0uNTEyLjIzMy0uMDUxLjA0LS4wOTQuMDktLjEzNy4xMzctLjM3Mi4zOTctLjgwNi42NTctMS4zNzMuNjI2LS44MjktLjA0Ni0xLjUzNy4yMTQtMi4xNjMuODQ4LS4xMzMtLjc4Mi0uNTc1LTEuMjQ4LTEuMjQ3LTEuNTQ4LS4zNTItLjE1NS0uNzA4LS4zMTEtLjk1NS0uNjUtLjE3Mi0uMjQtLjIxOS0uNTA5LS4zMDUtLjc3NC0uMDU1LS4xNi0uMTEtLjMyMy0uMjkzLS4zNS0uMi0uMDMxLS4yNzguMTM2LS4zNTYuMjc2LS4zMTMuNTcyLS40MzQgMS4yMDItLjQyMiAxLjg0LjAyNyAxLjQzNi42MzMgMi41OCAxLjgzOCAzLjM5My4xMzcuMDk0LjE3Mi4xODcuMTI5LjMyMy0uMDgyLjI4LS4xOC41NTMtLjI2Ni44MzMtLjA1NS4xNzktLjEzNy4yMTgtLjMyOC4xNGE1LjUgNS41IDAgMCAxLTEuNzM3LTEuMTc5Yy0uODU3LS44MjgtMS42MzEtMS43NDMtMi41OTctMi40NmExMiAxMiAwIDAgMC0uNjg5LS40N2MtLjk4NS0uOTU3LjEzLTEuNzQzLjM4Ny0xLjgzNi4yNy0uMDk4LjA5NC0uNDMzLS43NzgtLjQyOC0uODcyLjAwMy0xLjY3LjI5NS0yLjY4Ny42ODVhMyAzIDAgMCAxLS40NjUuMTM2IDkuNiA5LjYgMCAwIDAtMi44ODMtLjEwMWMtMS44ODUuMjEtMy4zOSAxLjEtNC40OTcgMi42MjJDLjA4MiA4Ljc3Ni0uMjMxIDEwLjg1NC4xNTIgMTMuMDJjLjQwMyAyLjI4NCAxLjU2OCA0LjE3NSAzLjM2IDUuNjUzIDEuODU3IDEuNTMzIDMuOTk3IDIuMjg0IDYuNDM4IDIuMTQgMS40ODItLjA4NSAzLjEzMi0uMjg0IDQuOTk0LTEuODYuNDcuMjM0Ljk2Mi4zMjggMS43OC4zOTguNjI5LjA1OCAxLjIzNS0uMDMxIDEuNzA1LS4xMjkuNzM1LS4xNTUuNjg0LS44MzYuNDE4LS45NjEtMi4xNTUtMS4wMDQtMS42ODItLjU5NS0yLjExMi0uOTI2IDEuMDk1LTEuMjk1IDIuNzY4LTMuNTk4IDMuMjg0LTYuNzMzLjA1LS4zNDYuMTE1LS44MzQuMTA4LTEuMTE0LS4wMDQtLjE3MS4wMzUtLjIzOC4yMy0uMjU3YTQuMiA0LjIgMCAwIDAgMS41NDUtLjQ3NWMxLjM5Ny0uNzYzIDEuOTYtMi4wMTYgMi4wOTMtMy41MTcuMDItLjIzLS4wMDQtLjQ2Ny0uMjQ3LS41ODhNMTEuNTggMTguMTY4Yy0yLjA4OC0xLjY0Mi0zLjEwMS0yLjE4My0zLjUyLTIuMTYtLjM5LjAyNC0uMzIuNDcyLS4yMzQuNzYzLjA5LjI4OC4yMDcuNDg3LjM3MS43NC4xMTQuMTY3LjE5Mi40MTYtLjExMy42MDMtLjY3My40MTYtMS44NDItLjE0LTEuODk3LS4xNjgtMS4zNjEtLjgwMS0yLjUtMS44Ni0zLjMwMS0zLjMwNi0uNzc1LTEuMzkzLTEuMjI1LTIuODg4LTEuMjk5LTQuNDgyLS4wMi0uMzg1LjA5NC0uNTIyLjQ3Ny0uNTkyYTQuNyA0LjcgMCAwIDEgMS41My0uMDM4YzIuMTMxLjMxMSAzLjk0NiAxLjI2NCA1LjQ2NyAyLjc3NC44NjguODYgMS41MjUgMS44ODcgMi4yMDIgMi44OS43MiAxLjA2NiAxLjQ5NCAyLjA4MiAyLjQ4IDIuOTE1LjM0OC4yOTEuNjI2LjUxMy44OTIuNjc3LS44MDIuMDktMi4xNC4xMDktMy4wNTUtLjYxNXptMS4wMDEtNi40NGEuMzA2LjMwNiAwIDAgMSAuNDE1LS4yODcuMy4zIDAgMCAxIC4xMTMuMDc0LjMuMyAwIDAgMSAuMDg2LjIxNGMwIC4xNy0uMTM2LjMwNy0uMzA4LjMwN2EuMzAzLjMwMyAwIDAgMS0uMzA2LS4zMDdtMy4xMSAxLjU5NmMtLjIuMDgxLS40LjE1MS0uNTkxLjE2YTEuMjUgMS4yNSAwIDAgMS0uNzk4LS4yNTRjLS4yNzQtLjIzLS40Ny0uMzU4LS41NTEtLjc1OGExLjcgMS43IDAgMCAxIC4wMTUtLjU4OGMuMDctLjMyNy0uMDA3LS41MzctLjIzOC0uNzI3LS4xODgtLjE1Ni0uNDI2LS4xOTktLjY4OS0uMTk5YS42LjYgMCAwIDEtLjI1NC0uMDc4LjI1My4yNTMgMCAwIDEtLjExNC0uMzU4IDEgMSAwIDAgMSAuMTkyLS4yMWMuMzU2LS4yMDIuNzY3LS4xMzYgMS4xNDYuMDE2LjM1Mi4xNDQuNjE4LjQwOCAxLjAwMS43ODIuMzkyLjQ1MS40NjIuNTc2LjY4NS45MTUuMTc2LjI2NC4zMzYuNTM2LjQ0Ni44NDguMDY2LjE5NC0uMDIuMzUzLS4yNS40NSIvPjwvc3ZnPg==",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ],
  },
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
