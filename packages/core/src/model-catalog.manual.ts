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
 * inference. Those are the entries here, plus any model a provider has
 * shipped since the snapshot was taken: models.dev trails releases by
 * days or weeks, and a model missing from the picker cannot be chosen
 * for Claude Code in the console at all, because the field is a select
 * whenever the provider is known.
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
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    // The generated entry supplies the mark and comes first in the
    // merge, so only the model ids below are ever read from here.
    logo: "",
    /**
     * Models Anthropic serves that the 2026-08-19 snapshot predates.
     * The id is the one the Claude API takes, with no date suffix.
     * Claude Mythos 5.1 is deliberately absent: it is served only to
     * organizations in Project Glasswing, so listing it would put a
     * model most keys cannot use in front of everybody. It stays
     * typeable through the API and the TUI, like any unlisted id.
     *
     * Delete this entry once `pnpm models:update` brings the id in;
     * until then the merge keeps it from duplicating.
     */
    models: [{ id: "claude-fable-5-1", name: "Claude Fable 5.1" }],
  },
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
    id: "antigravity",
    name: "Antigravity",
    env: ["GEMINI_API_KEY"],
    // No mark: there is none in the repository, and inventing a brand
    // mark is worse than the empty slot ProviderMark already draws.
    logo: "",
    /**
     * Antigravity's own model slugs, which is what its `--model`
     * takes. They are not the Gemini API's ids: a slug names the model
     * tier and the reasoning effort together, because effort is a
     * variant of the model in Antigravity rather than a separate
     * request field. That is why this is a provider of its own rather
     * than ids appended to Google's; `google/gemini-3.1-pro-high` is
     * not a thing pi or opencode could run.
     *
     * Only the ids that have been read back from Antigravity's own
     * model list are here. Gemini 3.8 Flash and 3.7 Flash are served
     * to a Gemini API key too, and they will join this list when
     * somebody has confirmed how their slugs are spelled rather than
     * from a guess at the pattern. Until then they stay typeable, like
     * any unlisted id.
     *
     * Antigravity also serves Claude and GPT models on a signed-in
     * Google account. A sandbox cannot sign in, so those are
     * unreachable here and deliberately unlisted.
     */
    models: [
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
      { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
      { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
      { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
      { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
      { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
      { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
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
  {
    id: "meta",
    name: "Meta",
    env: ["META_API_KEY"],
    // No mark: there is none in the repository, and inventing a brand
    // mark is worse than the empty slot ProviderMark already draws.
    logo: "",
    /**
     * Muse Spark, as Muse Code's `--model` takes it. The generated
     * snapshot lists some of these weights under OpenRouter as
     * `meta/muse-spark-*`, which is a different endpoint and a
     * different key, so this provider is its own entry rather than
     * ids appended to that one.
     *
     * Bare ids, newest first. Contributor variants are cheaper and
     * train on prompts; they stay listed because they are published
     * ids a key can actually call, not guesses.
     */
    models: [
      { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
      { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
      { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
      { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
      { id: "muse-spark-1.1", name: "Muse Spark 1.1" },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    env: ["AI_GATEWAY_API_KEY"],
    // Official mark: the Vercel triangle. Same treatment as Cursor's
    // own mark, which is also drawn by hand because models.dev has no
    // Vercel provider for us to inherit from.
    logo: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBmaWxsPSJjdXJyZW50Q29sb3IiIGQ9Ik0xMiAzLjIgMjIuNCAyMS4ySDEuNkwxMiAzLjJ6Ii8+PC9zdmc+",
    /**
     * Gateway slugs, which is what `FX_MODEL` and `fx ask` take. They
     * look like OpenRouter ids (`moonshotai/kimi-k3`) and are a
     * different endpoint, a different key, and a different bill, so
     * this is a provider of its own rather than ids appended to
     * OpenRouter or to the vendor behind the slug.
     *
     * Only the ids fx's own docs name. The Gateway catalog is large
     * and changes with the Vercel team; unlisted slugs stay typeable,
     * the same as any other unlisted id. See checkAgentPairing.
     */
    models: [
      { id: "moonshotai/kimi-k3", name: "Kimi K3" },
      { id: "openai/gpt-5.4", name: "GPT-5.4" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    env: ["OLLAMA_API_KEY"],
    logo: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xMi4xNzY2IDQuNTc3MzhDMTIuNzQyNCA0LjQ1MjQ4IDEzLjMyNTMgNC40ODIxIDEzLjg3MTkgNC42NDgwMkMxNC4zMzEzIDQuNzg3NzEgMTQuNzQ2NyA1LjAxNzYgMTUuMTIzMiA1LjMyMTU4QzE1Ljc1MDYgNS44MjQ1MiAxNi4yODA1IDYuNTQ0ODQgMTYuNjg0NyA3LjM5Nzc4QzE3LjA5MTEgOC4yNTU4OSAxNy4zNTU1IDkuMjA2NzIgMTcuNDU1NSAxMC4xNjAyQzE4Ljc5NDYgOS41NzQ4NSAyMC4yODA2IDkuMjE3OTcgMjEuODEzNCA5LjExNDQ5TDIxLjkyMTkgOS4xMDgxOUMyMy43NzI3IDguOTkzMTIgMjUuNjAyNiA5LjI1MTU0IDI3LjE5ODEgOS44ODc3MkMyNy40MTI5IDkuOTc0ODMgMjcuNjIzOCAxMC4wNjc5IDI3LjgzMDEgMTAuMTY2NUMyNy45MzY0IDkuMjMxMzYgMjguMTk2IDguMzAyODMgMjguNTk1OCA3LjQ2NDY0QzI4Ljk5OTkgNi42MDk4MiAyOS41MzA3IDUuODkwNTkgMzAuMTU2MSA1LjM4NTkxQzMwLjUwNTUgNS4wOTM5NiAzMC45MzI5IDQuODY0MTEgMzEuNDA4NiA0LjcxMjM1QzMxLjk1NTEgNC41NDgwNSAzMi41MzU3IDQuNTE4MiAzMy4xMDE0IDQuNjQyOTdDMzMuOTU0NSA0LjgzMDM3IDM0LjY4NjggNS4yNDg1NSAzNS4yNjMzIDUuODU1MTVDMzUuMzQ1OSA1Ljk0MTg4IDM1LjQyNDMgNi4wMzMyNSAzNS41MDA1IDYuMTI3NTlWMTUuOTUxMUMzNS4zOTY2IDE1Ljg4MDcgMzUuMjkwMSAxNS44MTI2IDM1LjE4IDE1Ljc0OEMzMy45MTQyIDE1LjAwMTcgMzIuMjM3OSAxNC42NDE2IDMwLjExNyAxNC43NDUyQzI5LjgzOTYgMTQuNzU5MSAyOS41NjMyIDE0LjcwNzYgMjkuMzIzNiAxNC41OTg5QzI5LjA4NCAxNC40OTAyIDI4Ljg5MTggMTQuMzI4NiAyOC43NzI0IDE0LjEzNDdDMjguMTA0MyAxMy4wNDE3IDI3LjEzMDEgMTIuMjU5NiAyNS45MTU0IDExLjc3NDdDMjQuNzQ5MiAxMS4zMjUgMjMuNDQzIDExLjEzNTUgMjIuMTQ1MSAxMS4yMjg1QzE5LjQ5NjkgMTEuMzkxNCAxNy4xNjEgMTIuNTQ1MSAxNi40NjUzIDEzLjk5OThDMTYuMzY2OCAxNC4yMDQ1IDE2LjE5MDEgMTQuMzgxOSAxNS45NTgyIDE0LjUwNjhDMTUuNzI2MyAxNC42MzE2IDE1LjQ0OTkgMTQuNjk4MiAxNS4xNjczIDE0LjY5ODZDMTIuODk3OCAxNC43MDE5IDExLjE0MDUgMTUuMTEyNyA5Ljg1NTcyIDE1Ljg1NEM4Ljc0NTIxIDE2LjQ5NTEgNy45ODc3NSAxNy4zOTE2IDcuNTg3NzkgMTguNDY0OUM3LjIyNTkzIDE5LjQ3NTQgNy4xNzU5NSAyMC41Mzc1IDcuNDQyNzQgMjEuNTY1NEM3LjY4MTAxIDIyLjQ4MjUgOC4xNDc0MiAyMy4yNDI0IDguNjgxMzkgMjMuNjUxN0w4LjY5OTA1IDIzLjY2MzFDOS4xNDk2NSAyNC4wMDM0IDkuMjQ0NjIgMjQuNTM0NCA4LjkyOTg4IDI0Ljk1MzRDOC4xNjQxNCAyNS45NzU5IDcuNTkxODMgMjcuNSA3LjQ5ODIzIDI4Ljk2NDVDNy4zOTE5MiAzMC42Mzc5IDcuODk0NDMgMzIuMDkxMSA5LjAyODI3IDMzLjEzMzRMOS4wNjIzMiAzMy4xNjQ5QzkuMjMzMjcgMzMuMzE4OCA5LjM0MzA0IDMzLjUwNzYgOS4zNzg5MyAzMy43MDg1QzkuNDE0NzYgMzMuOTA5NiA5LjM3NDk3IDM0LjExNDYgOS4yNjQxNCAzNC4yOTg4QzkuMDEzNzMgMzQuNzE0MSA4Ljc5OTY3IDM1LjExNDYgOC42MTk1OSAzNS40OTk2SDUuNzAyMDZDNS44ODM2NyAzNS4wMzEyIDYuMTA3NTcgMzQuNTQ5NCA2LjM3NTYyIDM0LjA1NTVMNi40MDQ2MyAzMy45OTczTDYuMzg4MjQgMzMuOTc4NUM1LjgxMjEyIDMzLjMyMDkgNS4zODE2MiAzMi41OTM1IDUuMTE1NTIgMzEuODI2Nkw1LjEwNTQzIDMxLjc5NTFDNC43ODI1NCAzMC44Mzg0IDQuNjU0OTEgMjkuODQ4NCA0LjcyODI4IDI4Ljg2MTJDNC44MjE4OSAyNy4zNjUzIDUuMzE5NjMgMjUuODMyNCA2LjA1MTQ2IDI0LjYwMjhMNi4wNzc5NSAyNC41NTk5TDYuMDcyOSAyNC41NTczQzUuNDQ5NiAyMy44NzAyIDQuOTg4NjEgMjIuOTkgNC43MzMzMyAyMi4wMTY5TDQuNzIxOTggMjEuOTc3OUM0LjM3MDI3IDIwLjYyMDUgNC40MzgyNSAxOS4yMTgxIDQuOTIwMDEgMTcuODg0N0M1LjQ3NzM5IDE2LjM4MDYgNi41NzM1IDE1LjA4ODYgOC4xODgxOSAxNC4xNTQ5QzguMzE1NjMgMTQuMDgxMSA4LjQ0OTIxIDE0LjAwNjkgOC41ODMwMSAxMy45Mzc5QzguMjQ0NzYgMTEuNDgzOCA4LjMzMDA1IDkuNDUwMDUgOC44MjE0MSA3LjkwNDg1QzkuMDkxNTMgNy4wNTM1MiA5LjQ4OTc3IDYuMzQzNDUgMTAuMDE3MiA1Ljc4OTU1QzEwLjU5MTYgNS4xODQ2MyAxMS4zMjM2IDQuNzY2NDQgMTIuMTc2NiA0LjU3NzM4Wk0xMi44NzY3IDYuNjQwOTZDMTIuNjMwMyA2LjcyMzggMTIuNDE5MyA2Ljg1OTQgMTIuMjcgNy4wMzE5OUwxMi4yNTk5IDcuMDQyMDhDMTEuOTY2NCA3LjM1Mjc4IDExLjcxMDkgNy44MDk0OSAxMS41MTk1IDguNDA5NEMxMS4xNTc4IDkuNTQ2OTUgMTEuMDYwMSAxMS4wOTEgMTEuMjU1OCAxMi45ODMxQzEyLjE3MDYgMTIuNzcyNyAxMy4xNjg0IDEyLjY0MSAxNC4yNDI3IDEyLjU5MzNMMTQuMjY0MiAxMi41OTA4TDE0LjMwNDUgMTIuNTM1M0MxNC40MDIyIDEyLjQwMDggMTQuNTA2MSAxMi4yNzEgMTQuNjE4NiAxMi4xNDNDMTQuODgwMiAxMC44NzU4IDE0LjY2NjEgOS4zNjE2NiAxNC4wODEzIDguMTI1NTlDMTMuNzk2MyA3LjUyNzQxIDEzLjQ0OTQgNy4wNTY1NSAxMy4xMTc2IDYuNzg4NTVDMTMuMDQ5MSA2LjczMjg2IDEyLjk3MiA2LjY4MzYxIDEyLjg4OTMgNi42NDA5NkwxMi44ODMgNi42MzcxOUwxMi44NzY3IDYuNjQwOTZaTTMyLjM5NjMgNi43MDQwM0MzMi4zMTM1IDYuNzQ2NjcgMzIuMjM2NSA2Ljc5NzE5IDMyLjE2NzkgNi44NTI4OEMzMS44MzYxIDcuMTIwODQgMzEuNDg3MyA3LjU5MjkgMzEuMjA0MyA4LjE5MTE4QzMwLjU4NzUgOS40OTYzNSAzMC4zODA4IDExLjExMDkgMzAuNzE0OSAxMi40MTkzTDMwLjgzODUgMTIuNTc4MkwzMC44NTQ5IDEyLjYwMDlIMzAuOTE5MkMzMS45NzUgMTIuNjAxMSAzMy4wMjU4IDEyLjcxOTQgMzQuMDM4NSAxMi45NTAzQzM0LjIyMTQgMTEuMTAyNiAzNC4xMTkyIDkuNTkxMTkgMzMuNzY2MSA4LjQ3NDk5QzMzLjU3NDUgNy44NzUwNyAzMy4zMTg5IDcuNDE4MzYgMzMuMDIzMSA3LjEwNzY3TDMzLjAxNDMgNy4wOTc1OEMzMi44NjUyIDYuOTI0NTIgMzIuNjU1NSA2Ljc4NzI5IDMyLjQwODggNi43MDQwM0wzMi40IDYuNzAyNzhMMzIuMzk2MyA2LjcwNDAzWiIgZmlsbD0iY3VycmVudENvbG9yIi8+CjxwYXRoIGQ9Ik0yMS41MjA4IDIyLjg0NjlDMjEuNzE3NSAyMi44MzEyIDIxLjkxNTUgMjIuODc2IDIyLjA2OTUgMjIuOTcxOEwyMi41MjYyIDIzLjI1NTVMMjIuOTk0MSAyMi45NjkyQzIzLjE0NzYgMjIuODc1NSAyMy4zNDMgMjIuODMxNCAyMy41Mzc4IDIyLjg0NjlDMjMuNzMyNCAyMi44NjI2IDIzLjkxMiAyMi45MzY0IDI0LjAzNzMgMjMuMDUyNUwyNC4wNDYgMjMuMDYwMUMyNC4zMDA5IDIzLjMwODEgMjQuMjQ3MyAyMy42Njc3IDIzLjkyNjIgMjMuODY0OEwyMy4zMDU3IDI0LjI0MzJWMjQuOTc2MUMyMy4zMDQ1IDI1LjEzOTEgMjMuMjE5NCAyNS4yOTUgMjMuMDY5OCAyNS40MUMyMi45MiAyNS41MjQ4IDIyLjcxNyAyNS41ODk0IDIyLjUwNTkgMjUuNTg5MUMyMi4yOTQ2IDI1LjU4OTUgMjIuMDkwOCAyNS41MjQ5IDIxLjk0MDggMjUuNDFDMjEuNzkxMiAyNS4yOTUgMjEuNzA2IDI1LjEzOTEgMjEuNzA1IDI0Ljk3NjFWMjQuMjIwNUwyMS4xMjg1IDIzLjg2MjNDMjEuMDUyNyAyMy44MTUzIDIwLjk4OTkgMjMuNzU2NyAyMC45NDMyIDIzLjY5MDdDMjAuODk2NCAyMy42MjQ3IDIwLjg2NjMgMjMuNTUxMiAyMC44NTYxIDIzLjQ3NjNDMjAuODQ1OSAyMy40MDE3IDIwLjg1NTEgMjMuMzI2MiAyMC44ODI2IDIzLjI1NDJDMjAuOTEwMyAyMy4xODIgMjAuOTU3MiAyMy4xMTQ2IDIxLjAxODggMjMuMDU2MkMyMS4xNDQzIDIyLjkzODQgMjEuMzI0NCAyMi44NjI3IDIxLjUyMDggMjIuODQ2OVoiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTIyLjYyODQgMTkuNTkxM0MyNC42MTk1IDE5LjU5MTMgMjYuNDU4NCAyMC4xMDU1IDI3LjgzMjcgMjAuOTk2NUMyOS4xNzI3IDIxLjg2MjYgMjkuOTcwNSAyMy4wMjY0IDI5Ljk3MDcgMjQuMTg1M0MyOS45NzA3IDI1LjY0NDggMjkuMTA2NiAyNi43ODIyIDI3LjU2MDIgMjcuNTA4OUMyNi4yNDEyIDI4LjEyNTMgMjQuNDczMiAyOC40MjQ3IDIyLjQ0NzkgMjguNDI0N0MyMC4zMDE0IDI4LjQyNDcgMTguNDY3MSAyNy45OTk2IDE3LjE0MzkgMjcuMjE4OEMxNS44MzE0IDI2LjQ0NjEgMTUuMDk1NSAyNS4zNjA0IDE1LjA5NTUgMjQuMTg1M0MxNS4wOTU3IDIzLjAyMzIgMTUuOTQyMyAyMS44NTU4IDE3LjM0MTkgMjAuOTg2NEMxOC43NjMgMjAuMTAzNiAyMC42Mzk0IDE5LjU5MTQgMjIuNjI4NCAxOS41OTEzWk0yMi42Mjg0IDIxLjA2MzRDMjEuMTUyNyAyMS4wNTM0IDE5LjcxNiAyMS40MzAyIDE4LjU1MjkgMjIuMTMxN0MxNy41NzIxIDIyLjczOTkgMTcuMDE2NSAyMy41MDU2IDE3LjAxNjUgMjQuMTg3N0MxNy4wMTY4IDI0Ljg5MTEgMTcuNDYzOSAyNS41NDk1IDE4LjMxNDQgMjYuMDUwOEMxOS4yODI1IDI2LjYyMTEgMjAuNzA1NSAyNi45NTI2IDIyLjQ0NzkgMjYuOTUyNkMyNC4xNDczIDI2Ljk1MjYgMjUuNTgxIDI2LjcxMDkgMjYuNTU3NSAyNi4yNTI1QzI3LjU0MjUgMjUuNzkyMiAyOC4wNDcyIDI1LjEyMzkgMjguMDQ3MiAyNC4xODUzQzI4LjA0NjkgMjMuNDg5OCAyNy41MjM1IDIyLjcyMTggMjYuNTk0MSAyMi4xMjAzQzI1LjU2NDQgMjEuNDU0NyAyNC4xNjg0IDIxLjA2MzQgMjIuNjI4NCAyMS4wNjM0WiIgZmlsbD0iY3VycmVudENvbG9yIi8+CjxwYXRoIGQ9Ik0xMy4zMTQyIDE5Ljg5NzhDMTQuMzMxIDE5Ljg5NzggMTUuMTU5NSAyMC41NCAxNS4xNTk1IDIxLjMzMDhDMTUuMTU5OSAyMS43MDkzIDE0Ljk2NTUgMjIuMDcyNyAxNC42MTk3IDIyLjM0MTFDMTQuMjczNSAyMi42MDk1IDEzLjgwMzMgMjIuNzYxNCAxMy4zMTI5IDIyLjc2MjRDMTIuODIzMSAyMi43NjExIDEyLjM1MzEgMjIuNjA5MSAxMi4wMDc0IDIyLjM0MTFDMTEuNjYyMSAyMi4wNzMxIDExLjQ2NzYgMjEuNzEwMSAxMS40Njc1IDIxLjMzMkMxMS40NjY0IDIwLjk1MzIgMTEuNjYwNSAyMC41ODkxIDEyLjAwNjEgMjAuMzIwNEMxMi4zNTE5IDIwLjA1MTYgMTIuODIzOSAxOS44OTk0IDEzLjMxNDIgMTkuODk3OFoiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8cGF0aCBkPSJNMzEuODM2NCAxOS44OTc4QzMyLjg1NzQgMTkuODk3OCAzMy42ODMgMjAuNTQgMzMuNjgzIDIxLjMzMDhDMzMuNjgzNCAyMS43MDk1IDMzLjQ4OTIgMjIuMDcyNyAzMy4xNDMxIDIyLjM0MTFDMzIuNzk2OCAyMi42MDk1IDMyLjMyNjcgMjIuNzYxNSAzMS44MzY0IDIyLjc2MjRDMzEuMzQ2NiAyMi43NjExIDMwLjg3NzkgMjIuNjA5MSAzMC41MzIxIDIyLjM0MTFDMzAuMTg2NiAyMi4wNzMxIDI5Ljk5MjMgMjEuNzEwNCAyOS45OTIyIDIxLjMzMkMyOS45OTEgMjAuOTUzMiAzMC4xODQgMjAuNTg5MSAzMC41Mjk1IDIwLjMyMDRDMzAuODc1MyAyMC4wNTE2IDMxLjM0NTggMTkuODk5MiAzMS44MzY0IDE5Ljg5NzhaIiBmaWxsPSJjdXJyZW50Q29sb3IiLz4KPC9zdmc+Cg==",
    /**
     * Ollama Cloud's models, read back from https://ollama.com/v1/models
     * on 2026-09-11, newest first. The ids are the ones Ollama Cloud
     * takes; agents name them with Bento's ollama/ prefix, which the
     * adapters strip (see ollama.ts).
     *
     * Hand maintained rather than generated, although models.dev has an
     * "ollama-cloud" provider: its id is not the prefix Bento uses, and
     * it still lists models Ollama Cloud has retired.
     *
     * A server of the organization's own (OLLAMA_BASE_URL) serves
     * whatever was pulled onto it, under names no list can know, so
     * those are typed. The same goes for a signed in local server, which
     * serves these cloud models with a -cloud suffix (gpt-oss:120b-cloud).
     */
    models: [
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
      { id: "glm-5.3", name: "GLM 5.3" },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
      { id: "deepseek-v4-pro:0813", name: "DeepSeek V4 Pro (0813)" },
      { id: "deepseek-v4-flash:0731", name: "DeepSeek V4 Flash (0731)" },
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "glm-5.2", name: "GLM 5.2" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra" },
      { id: "minimax-m3", name: "MiniMax M3" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
      { id: "glm-5.1", name: "GLM 5.1" },
      { id: "gemma4:31b", name: "Gemma 4 31B" },
      { id: "minimax-m2.7", name: "MiniMax M2.7" },
      { id: "nemotron-3-super", name: "Nemotron 3 Super" },
      { id: "qwen3.5:397b", name: "Qwen 3.5 397B" },
      { id: "nemotron-3-nano:30b", name: "Nemotron 3 Nano 30B" },
      { id: "mistral-large-3:675b", name: "Mistral Large 3 675B" },
      { id: "gpt-oss:120b", name: "gpt-oss 120B" },
      { id: "gpt-oss:20b", name: "gpt-oss 20B" },
    ],
  },
];
