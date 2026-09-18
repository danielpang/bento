import { and, eq, isNull } from "drizzle-orm";
import { supportsCustomProvider } from "@bento/core";
import type { CustomProviderSelection } from "@bento/agents";
import { customModelProviders } from "@bento/db";
import type { AppContext } from "../context.js";

export interface CustomProviderRunConfig {
  env: Record<string, string>;
  selection?: CustomProviderSelection;
  missingKey: boolean;
  missingModel?: boolean;
  unsupported?: boolean;
}

/** Resolve the selected organization provider and the config its harness needs. */
export async function customProviderRunEnv(
  ctx: AppContext,
  organizationId: string | null,
  cli: string,
  model: string,
): Promise<CustomProviderRunConfig | null> {
  // An old organization-less project on a multi-tenant server must
  // never receive a key that was saved in local mode.
  if (ctx.env.BENTO_MODE === "multi" && !organizationId) return null;
  const slug = model.split("/")[0];
  if (!slug) return null;
  const [row] = await ctx.db.select().from(customModelProviders).where(and(
    organizationId ? eq(customModelProviders.organizationId, organizationId) : isNull(customModelProviders.organizationId),
    eq(customModelProviders.slug, slug),
  ));
  if (!row) return null;
  const modelId = model.slice(slug.length + 1);
  if (!row.models.some((entry) => entry.id === modelId)) return { env: {}, missingKey: false, missingModel: true };
  if (!supportsCustomProvider(cli, row.protocol)) return { env: {}, missingKey: false, unsupported: true };
  let apiKey: string | null = null;
  if (row.encryptedApiKey) {
    try { apiKey = ctx.secretBox.decrypt(row.encryptedApiKey); } catch { /* rotated key is missing */ }
  }
  if (!apiKey) return { env: {}, missingKey: true };
  const selection: CustomProviderSelection = {
    slug: row.slug,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    modelId,
    models: row.models,
  };
  const env: Record<string, string> = { BENTO_CUSTOM_PROVIDER_API_KEY: apiKey };
  if (cli === "opencode") {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { [row.slug]: {
        npm: row.protocol === "anthropic" ? "@ai-sdk/anthropic"
          : row.protocol === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        name: row.name,
        options: { baseURL: row.baseUrl, apiKey: "{env:BENTO_CUSTOM_PROVIDER_API_KEY}" },
        models: Object.fromEntries(row.models.map((entry) => [entry.id, { name: entry.name }])),
      } },
    });
  }
  if (cli === "claude-code") {
    Object.assign(env, {
      ANTHROPIC_BASE_URL: row.baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
      CLAUDE_CODE_SUBAGENT_MODEL: modelId,
    });
  }
  return {
    missingKey: false,
    selection,
    env,
  };
}
