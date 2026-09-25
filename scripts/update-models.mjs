#!/usr/bin/env node
/**
 * Refreshes the model catalog from models.dev.
 *
 * The catalog is committed rather than fetched at runtime: a board that
 * cannot reach the internet still has to offer a model list, and a
 * dropdown whose contents change under you between sessions is worse
 * than one that changes when someone runs this script.
 *
 * Only providers whose credentials Bento can actually store are
 * included. Offering a model that no stored key can authenticate would
 * be a dropdown entry that always fails at run time.
 *
 * Cursor is the exception: models.dev has no Cursor provider (Composer
 * lives only inside Cursor), but it does describe xAI, whose Grok
 * models the Cursor CLI runs and bills through CURSOR_API_KEY. Those
 * Grok ids are generated here. Composer and Auto stay in
 * model-catalog.manual.ts and are merged on top.
 *
 * Vercel AI Gateway is a second snapshot. models.dev has no vercel
 * provider whose ids match what the Gateway takes (`moonshotai/kimi-k3`).
 * Those slugs come from https://ai-gateway.vercel.sh/v1/models, language
 * models only. Image, video, and embedding ids are not agent models.
 *
 * Usage: pnpm models:update
 *        pnpm models:update -- --gateway-only
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://models.dev/api.json";
const GATEWAY_API = "https://ai-gateway.vercel.sh/v1/models";
const LOGO = (id) => `https://models.dev/logos/${id}.svg`;
const gatewayOnly = process.argv.includes("--gateway-only");

/**
 * Official Vercel triangle. models.dev has no vercel logo for us to
 * inherit, so the mark is drawn here and copied into the snapshot.
 */
const VERCEL_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBmaWxsPSJjdXJyZW50Q29sb3IiIGQ9Ik0xMiAzLjIgMjIuNCAyMS4ySDEuNkwxMiAzLjJ6Ii8+PC9zdmc+";

/**
 * Providers we snapshot. `cursor` is listed so a later models.dev
 * entry is picked up automatically; today it is absent and skipped.
 */
const INCLUDE = ["anthropic", "openai", "google", "openrouter", "xai", "cursor"];
/** Providers whose public catalog must carry at least one usable rate. */
const PRICED_REQUIRED = new Set(["anthropic", "openai", "google", "openrouter", "xai"]);

/**
 * Per-provider overrides the snapshot cannot express.
 *
 * Bento stores no XAI_API_KEY. Grok is reachable here only through the
 * Cursor CLI, which pays for it with the Cursor key. Imagine image and
 * video models are not something an agent run can use.
 */
const OPTIONS = {
  xai: { env: ["CURSOR_API_KEY"], textOutputOnly: true },
};

/**
 * Models to lift to the top of a provider's list.
 *
 * OpenRouter's auto router picks a model per request, which is the entry
 * most people want first and the one alphabetical order buries deepest.
 */
const PINNED = {
  openrouter: ["openrouter/auto"],
  xai: ["grok-4.6", "grok-4.5"],
};

/** fx's default first, then the other slug its docs name. */
const GATEWAY_PINNED = ["moonshotai/kimi-k3", "openai/gpt-5.4"];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packages/core/src/model-catalog.generated.ts");
const gatewayOut = path.join(root, "packages/core/src/model-catalog.gateway.ts");

if (!gatewayOnly) {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const api = await res.json();

  const providers = [];
  for (const id of INCLUDE) {
    const provider = api[id];
    if (!provider) {
      console.warn(`skipping ${id}: not in the models.dev catalog`);
      continue;
    }
    const options = OPTIONS[id] ?? {};
    const pinned = PINNED[id] ?? [];
    const rank = (modelId) => {
      const at = pinned.indexOf(modelId);
      return at === -1 ? pinned.length : at;
    };
    const models = Object.values(provider.models ?? {})
      .filter((m) => !options.textOutputOnly || outputsText(m))
      .map((m) => ({ id: m.id, name: m.name ?? m.id, ...listPrice(m) }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    for (const want of pinned) {
      if (!models.some((m) => m.id === want)) console.warn(`  pinned model ${want} is not in ${id}`);
    }
    if (models.length === 0) {
      console.warn(`skipping ${id}: no models listed`);
      continue;
    }
    const priced = models.filter((model) => model.cost).length;
    if (PRICED_REQUIRED.has(id) && priced === 0) {
      throw new Error(`${id} listed ${models.length} models but no input and output prices`);
    }

    const logoRes = await fetch(LOGO(id));
    let logo = "";
    if (logoRes.ok) {
      const svg = Buffer.from(await logoRes.arrayBuffer());
      logo = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    } else {
      console.warn(`no logo for ${id} (${logoRes.status})`);
    }

    providers.push({
      id,
      name: provider.name ?? id,
      env: options.env ?? provider.env ?? [],
      logo,
      models,
    });
    console.log(`${id}: ${models.length} models, ${priced} priced${logo ? "" : ", no logo"}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = `// Generated by scripts/update-models.mjs from ${API}
// Snapshot taken ${today}. Do not edit by hand: run \`pnpm models:update\`.
// Composer and other ids models.dev does not carry live in model-catalog.manual.ts.
import type { CatalogProvider } from "./models.js";

export const MODEL_CATALOG: readonly CatalogProvider[] = ${JSON.stringify(providers, null, 2)};
`;

  await writeFile(out, body);
  console.log(`\nwrote ${path.relative(root, out)} (${(body.length / 1024).toFixed(0)} KB)`);
}

await writeGatewayCatalog();

/**
 * What a model lists at, in dollars per million tokens.
 *
 * models.dev quotes `cost.input` and `cost.output` in exactly those
 * units, so the figures are copied rather than converted. Only the two
 * that price a run are kept: cache reads and cache writes are real
 * charges, but no agent CLI reports its cache token counts, so
 * carrying them would be a number nothing could ever multiply.
 *
 * A model the snapshot does not price keeps no `cost` key at all,
 * which is what the ledger reads as "this cannot be estimated" and
 * charges at the assumed tier instead. A zero would read as free.
 */
function listPrice(model) {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return {};
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return {};
  return { cost: { input, output } };
}

/** Keep models an agent can actually write with. Image/video-only drops. */
function outputsText(model) {
  const output = model.modalities?.output;
  if (!Array.isArray(output) || output.length === 0) return true;
  return output.includes("text");
}

/**
 * Language models the Gateway serves, under the slugs fx, pi, opencode,
 * and Codex actually send. Separate from the models.dev snapshot so a
 * Gateway-only refresh does not rewrite every other provider.
 */
async function writeGatewayCatalog() {
  const res = await fetch(GATEWAY_API);
  if (!res.ok) throw new Error(`AI Gateway returned ${res.status}`);
  const payload = await res.json();
  const listed = Array.isArray(payload?.data) ? payload.data : [];
  const rank = (modelId) => {
    const at = GATEWAY_PINNED.indexOf(modelId);
    return at === -1 ? GATEWAY_PINNED.length : at;
  };
  /*
   * No prices here, deliberately.
   *
   * The models.dev half carries `cost` in dollars per million tokens,
   * which is the unit every provider quotes and the unit the ledger
   * multiplies. The Gateway's listing is a different API with its own
   * shape and its own units, and a price copied into the wrong unit is
   * a budget wrong by six orders of magnitude. A Gateway model without
   * a price is charged at the assumed tier, which is the honest answer
   * until somebody reads that response and writes the conversion down.
   */
  const models = listed
    .filter((m) => m?.type === "language" && typeof m.id === "string" && m.id !== "")
    .map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name !== "" ? m.name : m.id }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  for (const want of GATEWAY_PINNED) {
    if (!models.some((m) => m.id === want)) console.warn(`  pinned model ${want} is not in vercel`);
  }
  if (models.length === 0) throw new Error("AI Gateway listed no language models");

  const today = new Date().toISOString().slice(0, 10);
  const catalog = [
    {
      id: "vercel",
      name: "Vercel AI Gateway",
      env: ["AI_GATEWAY_API_KEY"],
      logo: VERCEL_LOGO,
      models,
    },
  ];
  const body = `// Generated by scripts/update-models.mjs from ${GATEWAY_API}
// Snapshot taken ${today}. Do not edit by hand: run \`pnpm models:update\`.
// Language models only. Image, video, and embedding ids stay out.
import type { CatalogProvider } from "./models.js";

export const GATEWAY_CATALOG: readonly CatalogProvider[] = ${JSON.stringify(catalog, null, 2)};
`;
  await writeFile(gatewayOut, body);
  console.log(`vercel: ${models.length} language models`);
  console.log(`wrote ${path.relative(root, gatewayOut)} (${(body.length / 1024).toFixed(0)} KB)`);
}
