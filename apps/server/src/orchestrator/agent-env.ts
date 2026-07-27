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
  const wanted = [...required, ...(adapter.optionalEnv ?? []), ...(adapter.authAlternatives ?? [])];
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

  // A login token stands in for the API key wholesale: with one
  // present, nothing is missing and the run may start.
  if ((adapter.authAlternatives ?? []).some((name) => env[name])) {
    return { env, missing: [] };
  }
  return { env, missing: required.filter((name) => !env[name]) };
}
