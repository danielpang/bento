import { and, eq, inArray, isNull } from "drizzle-orm";
import { secrets } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * The environment an agent runs with.
 *
 * In multi mode this comes only from the owning organization's stored
 * secrets: the server's own credentials must never reach a tenant's
 * sandbox, because an agent there can read anything the sandbox can, and
 * a prompt injection is enough to exfiltrate it.
 *
 * Local mode has one trusted user, so the process environment is theirs
 * to use, with stored secrets layered on top.
 */
export async function resolveAgentEnv(
  ctx: AppContext,
  organizationId: string | null,
  adapter: {
    requiredEnv: string[];
    optionalEnv?: string[];
    authAlternatives?: string[];
    requiredEnvFor?(model: string): string[];
  },
  model?: string,
): Promise<{ env: Record<string, string>; missing: string[] }> {
  const env: Record<string, string> = {};
  // Provider agnostic tools require nothing in general and something
  // specific per model: an openrouter/ model needs the OpenRouter key.
  const required = (model && adapter.requiredEnvFor?.(model)) || adapter.requiredEnv;
  const alternatives = adapter.authAlternatives ?? [];
  const wanted = [...required, ...(adapter.optionalEnv ?? []), ...alternatives];
  if (wanted.length === 0) return { env, missing: [] };

  if (ctx.env.BENTO_MODE !== "multi") {
    for (const name of wanted) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
  }

  const rows = await ctx.db
    .select()
    .from(secrets)
    .where(
      and(
        organizationId ? eq(secrets.organizationId, organizationId) : isNull(secrets.organizationId),
        inArray(secrets.name, wanted),
      ),
    );
  for (const row of rows) {
    try {
      env[row.name] = ctx.secretBox.decrypt(row.ciphertext);
    } catch {
      // A secret encrypted with a rotated key is treated as missing,
      // which surfaces as a clear error rather than a broken agent.
    }
  }

  /**
   * A login token stands in for the API key wholesale, so exactly one
   * of the two may reach the CLI. Forwarding both leaves the choice to
   * the tool, and Claude Code takes the key: an organization that saved
   * a subscription token while a stale key sat beside it got "Invalid
   * API key" out of a run this function had already called fully
   * credentialled, with nothing anywhere naming the key as the cause.
   *
   * Which one gives way depends on the endpoint. A login token is only
   * valid at the provider's own API, so once a base URL points the tool
   * somewhere else (OpenRouter, a gateway) the key is the only
   * credential that can work and the token is the one to drop. `missing`
   * is then computed as usual, so a redirected tool with only a token
   * fails naming the key it needs rather than starting and failing as
   * an authentication error. Base URLs are recognized by suffix, the
   * same convention the console groups them by.
   */
  const redirected = wanted.some((name) => name.endsWith("_BASE_URL") && env[name]);
  if (!redirected && alternatives.some((name) => env[name])) {
    for (const name of required) delete env[name];
    return { env, missing: [] };
  }
  for (const name of alternatives) delete env[name];
  return { env, missing: required.filter((name) => !env[name]) };
}
