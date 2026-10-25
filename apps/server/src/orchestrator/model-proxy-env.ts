import { hasPersonalKeys, PERSONAL_KEYS_MARKER, type PersonalCredentialIds } from "../agent-accounts/credentials.js";
import type { AgentAdapter } from "@bento/agents";
import { MODEL_PROXY_PATH, modelProviderForKey } from "@bento/core";
import { collectExec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { modelProxyEnabled } from "../env.js";
import { mintRunGrant } from "../mcp/grants.js";
import { checkFetchable, safeFetchPolicy } from "../mcp/safe-fetch.js";
import { MODEL_PROXY_READY } from "../routes/model-proxy.js";
import { resolveGatewayBase, runGrantTtlMs } from "./mcp-run.js";

/**
 * Provider keys reach a sandbox only as run tokens: always in multi
 * mode, and in local mode on Docker unless BENTO_MODEL_PROXY is "false"
 * (modelProxyEnabled).
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
 * Local mode is one trusted user, but a Docker sandbox is still a
 * boundary: the agent in it reads untrusted input, and the key it
 * could print is the user's own, valid long after the run. So a local
 * Docker run is proxied too, with three differences:
 *
 * - The local process driver is never proxied. Its agent runs as the
 *   user, on the host, and can read the same environment and files the
 *   key came from; a token would protect nothing there.
 * - Before any key is swapped, the sandbox is asked to reach the proxy
 *   (probeModelProxy), once per run. A local server is bound to
 *   loopback, which Docker Desktop and OrbStack forward
 *   host.docker.internal to and Docker on Linux does not, so a sandbox
 *   that cannot reach it keeps its raw keys, as before the proxy, and
 *   the transcript says so. A local run must never lose its model to
 *   this.
 * - A saved base URL that names this machine's own loopback (or
 *   host.docker.internal) is not proxied: it names a different machine
 *   inside the sandbox than it does to Bento, so the key and its base
 *   URL stay as they were. Any other base URL, plain http and private
 *   addresses included, goes through the proxy, which in local mode
 *   fetches what the user saved: safeFetch's refusals are a tenant
 *   protection, and a local user is not a tenant.
 *
 * Anything the proxy does not carry stays as it was in either mode: a
 * subscription login, a Cursor credential, a custom provider, Ollama.
 * So does a multi mode key whose saved base URL the proxy could never
 * fetch (plain http, a private address): the sandbox reached it before
 * the proxy existed, and the proxy would refuse every request, so that
 * key and its base URL stay in the sandbox and the transcript says why.
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
  if (!modelProxyEnabled(ctx.env) || !adapter.modelProxy) return none;
  const local = ctx.env.BENTO_MODE !== "multi";
  // A local agent run as a process is the user, on the host: it reads
  // the environment and the files the key came from, so a token would
  // keep nothing from it.
  if (local && driver.provider === "local-process") return none;
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
    const keep = saved && (local ? namesThisMachine(saved) : !(await fetchable(saved, policy)));
    if (baseUrlKey && keep) {
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

/**
 * Whether a base URL names this machine: loopback, or Docker's name for
 * the host. Inside a sandbox that is a different machine from the one
 * Bento's server is on, so the proxy fetching it would not reach what
 * the agent would have.
 */
export function namesThisMachine(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host) ||
    host === "0.0.0.0" ||
    host === "host.docker.internal"
  );
}

/** The transcript's one sentence for a key left in the sandbox because of its saved base URL. */
export function unreachableBaseUrlNote(entry: { key: string; baseUrlKey: string }, mode: "local" | "multi" = "multi"): string {
  if (mode === "local") {
    return `${entry.baseUrlKey} names this machine, which is a different address inside the sandbox than it is to Bento, so this run's ${entry.key} is in its sandbox rather than behind the model proxy.`;
  }
  return `${entry.baseUrlKey} is not a public https address that Bento's model proxy can reach, so this run's ${entry.key} is in its sandbox rather than behind the proxy.`;
}

/** The transcript's one sentence for a local run whose sandbox could not reach the proxy. */
export const MODEL_PROXY_UNREACHABLE_NOTE =
  "This run's sandbox could not reach Bento's model proxy, so its model provider keys are in the sandbox for this run.";

/** How long the sandbox's one request to the proxy may take, end to end. */
const PROBE_TIMEOUT_SEC = 3;
/** And the exec around it, which on Docker is one more process in a running container. */
const PROBE_EXEC_TIMEOUT_MS = 10_000;

/**
 * Asks, from inside the sandbox, whether the proxy answers at the
 * address its base URLs will name. One request to the proxy's
 * readiness route (which reads nothing), with curl or else wget, and a
 * short timeout. True only when the answer is the proxy's own; a
 * sandbox with neither tool, a refused connection, a timeout, or any
 * other answer is false, and the caller keeps the raw keys.
 */
export async function probeModelProxy(
  driver: SandboxDriver,
  handle: SandboxHandle,
  gatewayBase: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${gatewayBase.replace(/\/+$/, "")}${MODEL_PROXY_PATH}`;
  const script = [
    'if command -v curl >/dev/null 2>&1; then exec curl -fsS --max-time "$2" "$1";',
    'elif command -v wget >/dev/null 2>&1; then exec wget -q -O - -T "$2" "$1";',
    'else echo "neither curl nor wget is installed" >&2; exit 127; fi',
  ].join(" ");
  try {
    const result = await collectExec(
      driver.exec(handle, ["sh", "-c", script, "bento-probe", url, String(PROBE_TIMEOUT_SEC)], {
        timeoutMs: PROBE_EXEC_TIMEOUT_MS,
      }),
    );
    if (result.exitCode === 0 && result.stdout.includes(MODEL_PROXY_READY)) return { ok: true, detail: url };
    const said = (result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? "";
    return { ok: false, detail: `${url}: exit ${result.exitCode}${said ? `, ${said}` : ""}` };
  } catch (err) {
    return { ok: false, detail: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
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
    /**
     * The machine the run will execute in. A local run asks it to reach
     * the proxy before its keys are swapped, and keeps them without it.
     */
    handle?: SandboxHandle;
    env: Record<string, string>;
    personalCredentialIds?: PersonalCredentialIds;
    say: (text: string) => Promise<void>;
  },
): Promise<{ env: Record<string, string>; grantToken: string | null }> {
  const mode = ctx.env.BENTO_MODE === "multi" ? "multi" : "local";
  const plan = await planModelProxy(ctx, input.adapter, input.driver, input.env);
  for (const entry of plan.unreachableBaseUrls) await input.say(unreachableBaseUrlNote(entry, mode));
  if (plan.keys.length === 0) return { env: input.env, grantToken: null };
  if (!plan.gatewayBase) {
    await input.say(
      "This deployment has no gateway URL a sandbox can reach, so the model provider keys for this run are in its sandbox rather than behind Bento's model proxy. Set BENTO_MCP_GATEWAY_URL.",
    );
    return { env: input.env, grantToken: null };
  }
  /*
   * Multi mode is not probed: its gateway is the deployment's public
   * address, which every hosted sandbox reaches, and a run there must
   * never fall back to keys. A local run is, because whether a sandbox
   * reaches a loopback server depends on the user's Docker, and the
   * proxy must never be what leaves a local run without its model.
   */
  if (mode === "local") {
    const probe = input.handle
      ? await probeModelProxy(input.driver, input.handle, plan.gatewayBase)
      : { ok: false, detail: "no sandbox to ask" };
    if (!probe.ok) {
      console.warn(`run ${input.runId}: the sandbox could not reach the model proxy (${probe.detail}); keeping its keys`);
      await input.say(MODEL_PROXY_UNREACHABLE_NOTE);
      return { env: input.env, grantToken: null };
    }
  }
  const token = await mintRunGrant(ctx, {
    runId: input.runId,
    organizationId: input.organizationId,
    actingUserId: input.actingUserId,
    serverIds: [],
    modelCredentials: [...grantedModelCredentials(input.env, plan.keys), ...(hasPersonalKeys(input.personalCredentialIds ?? {}) ? [PERSONAL_KEYS_MARKER] : [])],
    swarmId: input.swarmId ?? null,
    ttlMs: runGrantTtlMs(ctx),
  });
  return { env: proxiedAgentEnv(input.env, plan.keys, plan.gatewayBase, token), grantToken: token };
}
