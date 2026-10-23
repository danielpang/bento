import type { AgentAdapter } from "@bento/agents";
import { MODEL_PROXY_PATH, modelProviderForKey } from "@bento/core";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { mintRunGrant } from "../mcp/grants.js";
import { checkFetchable, safeFetchPolicy } from "../mcp/safe-fetch.js";
import { resolveGatewayBase, runGrantTtlMs } from "./mcp-run.js";

/**
 * Provider keys reach a multi mode sandbox only as run tokens.
 *
 * resolveAgentEnv decrypts the organization's keys, and an agent can
 * read anything its sandbox can, so a prompt injection was enough to
 * walk off with them. Here each key the adapter can send through the
 * model proxy (`adapter.modelProxy`) is replaced, under its own name,
 * by the run's grant token, and the provider's base URL variable is
 * set to the proxy's address for that provider. The proxy
 * (routes/model-proxy.ts) puts the real key back on the way out, and
 * the token dies with the run.
 *
 * Local mode is left alone: one trusted user, whose keys are theirs.
 * So is anything the proxy does not carry: a subscription login, a
 * Cursor credential, a custom provider, Ollama. And so is a key whose
 * saved base URL the proxy could never fetch (plain http, a private
 * address): the sandbox reached it before the proxy existed, and the
 * proxy would refuse every request, so that key and its base URL stay
 * in the sandbox and the transcript says why.
 */

export interface ModelProxyPlan {
  /** The keys this run's sandbox gets as tokens. */
  keys: string[];
  /** The gateway base the sandbox reaches the proxy on; null when it cannot reach one. */
  gatewayBase: string | null;
  /**
   * Keys the adapter could proxy whose saved base URL Bento's server
   * will not fetch, each with the variable that holds it. They reach
   * the sandbox as they did before the proxy.
   */
  unreachableBaseUrls: { key: string; baseUrlKey: string }[];
}

/**
 * Which of a run's resolved keys go through the proxy, and where the
 * sandbox reaches it. The Modal allowlist (which is built before any
 * grant exists) and the executor both ask this, so they reach the same
 * answer from the same environment.
 *
 * A saved base URL is checked here against the rule the proxy fetches
 * it by (safeFetch: public https only in multi mode), so a URL the
 * proxy would refuse on every request is never proxied in the first
 * place.
 */
export async function planModelProxy(
  ctx: AppContext,
  adapter: Pick<AgentAdapter, "modelProxy">,
  driver: SandboxDriver,
  env: Readonly<Record<string, string>>,
): Promise<ModelProxyPlan> {
  const none = { keys: [], gatewayBase: null, unreachableBaseUrls: [] };
  if (ctx.env.BENTO_MODE !== "multi" || !adapter.modelProxy) return none;
  // The local process driver writes nothing into the home it shares
  // with the operator, so a tool wired through a file there would be
  // handed a token and no address to spend it at.
  if (adapter.modelProxy.homeFile && driver.provider === "local-process") return none;
  const candidates = adapter.modelProxy.keys.filter((key) => env[key]?.trim() && modelProviderForKey(key)?.proxy);
  const keys: string[] = [];
  const unreachableBaseUrls: ModelProxyPlan["unreachableBaseUrls"] = [];
  const policy = safeFetchPolicy(ctx.env);
  for (const key of candidates) {
    const baseUrlKey = modelProviderForKey(key)?.baseUrlKey;
    const saved = baseUrlKey ? env[baseUrlKey]?.trim() : undefined;
    if (baseUrlKey && saved && !(await fetchable(saved, policy))) {
      unreachableBaseUrls.push({ key, baseUrlKey });
      continue;
    }
    keys.push(key);
  }
  if (keys.length === 0) return { ...none, unreachableBaseUrls };
  return { keys, gatewayBase: resolveGatewayBase(ctx, driver), unreachableBaseUrls };
}

async function fetchable(url: string, policy: ReturnType<typeof safeFetchPolicy>): Promise<boolean> {
  try {
    await checkFetchable(url, policy);
    return true;
  } catch {
    return false;
  }
}

/** The transcript's one sentence for a key left in the sandbox because of its saved base URL. */
export function unreachableBaseUrlNote(entry: { key: string; baseUrlKey: string }): string {
  return `${entry.baseUrlKey} is not a public https address that Bento's model proxy can reach, so this run's ${entry.key} is in its sandbox rather than behind the proxy.`;
}

/**
 * The environment a sandbox gets once `keys` are proxied: each key's
 * value is the token, and each one's base URL variable the proxy's
 * address for its provider. Every other variable is as resolved.
 */
export function proxiedAgentEnv(
  env: Readonly<Record<string, string>>,
  keys: readonly string[],
  gatewayBase: string,
  token: string,
): Record<string, string> {
  const out = { ...env };
  for (const key of keys) {
    const route = modelProviderForKey(key)?.proxy;
    if (!route) continue;
    out[key] = token;
    out[route.baseUrlEnv] = `${gatewayBase.replace(/\/+$/, "")}${MODEL_PROXY_PATH}/${route.segment}`;
  }
  return out;
}

/**
 * The stored secrets the proxy may read for this run: the keys, and the
 * base URL the organization saved for one of them when the run had it.
 * A saved base URL is where the key would have gone without the proxy,
 * so the proxy sends it there too; it is named only when the adapter
 * forwarded it, so a tool that never read the organization's base URL
 * does not start going to it now.
 */
export function grantedModelCredentials(env: Readonly<Record<string, string>>, keys: readonly string[]): string[] {
  const names = new Set<string>();
  for (const key of keys) {
    names.add(key);
    const baseUrlKey = modelProviderForKey(key)?.baseUrlKey;
    if (baseUrlKey && env[baseUrlKey]?.trim()) names.add(baseUrlKey);
  }
  return [...names];
}

/**
 * Swaps a run's provider keys for its grant token, minting the grant.
 *
 * Returns the environment the sandbox gets and the token, which
 * prepareRunMcp then reuses so the MCP gateway and the proxy ride one
 * grant (a second mint would replace the token this environment holds).
 * A run with nothing to proxy returns its environment as it was and no
 * token. A run whose sandbox cannot reach the gateway keeps its raw
 * keys, the way it ran before the proxy existed, and the transcript
 * says why.
 */
export async function proxyModelCredentials(
  ctx: AppContext,
  input: {
    runId: string;
    organizationId: string | null;
    actingUserId: string | null;
    swarmId?: string | null;
    adapter: Pick<AgentAdapter, "modelProxy">;
    driver: SandboxDriver;
    env: Record<string, string>;
    say: (text: string) => Promise<void>;
  },
): Promise<{ env: Record<string, string>; grantToken: string | null }> {
  const plan = await planModelProxy(ctx, input.adapter, input.driver, input.env);
  for (const entry of plan.unreachableBaseUrls) await input.say(unreachableBaseUrlNote(entry));
  if (plan.keys.length === 0) return { env: input.env, grantToken: null };
  if (!plan.gatewayBase) {
    await input.say(
      "This deployment has no gateway URL a sandbox can reach, so the model provider keys for this run are in its sandbox rather than behind Bento's model proxy. Set BENTO_MCP_GATEWAY_URL.",
    );
    return { env: input.env, grantToken: null };
  }
  const token = await mintRunGrant(ctx, {
    runId: input.runId,
    organizationId: input.organizationId,
    actingUserId: input.actingUserId,
    serverIds: [],
    modelCredentials: grantedModelCredentials(input.env, plan.keys),
    swarmId: input.swarmId ?? null,
    ttlMs: runGrantTtlMs(ctx),
  });
  return { env: proxiedAgentEnv(input.env, plan.keys, plan.gatewayBase, token), grantToken: token };
}
