import { MODEL_PROXY_PATH } from "@bento/core";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { mintRunGrant } from "../mcp/grants.js";
import { resolveGatewayBase, runGrantTtlMs } from "../orchestrator/mcp-run.js";
import { personalKey, personalMarker, personalSegment } from "./store.js";
import type { AccountProvider } from "./oauth.js";

/** These carry only a Bento token, not a provider credential or real account id.
 * Pi's native adapters inspect OAuth token shapes before constructing requests.
 * The proxy unwraps them and authenticates the opaque grant in the usual way.
 */
export function subscriptionRunToken(token: string, provider: AccountProvider) {
  if (provider === "anthropic") return `sk-ant-oat01-bento-${token}`;
  const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "bento-run" } })).toString("base64url");
  return `${token}.${claim}.bento`;
}
export async function proxyPersonalAccount(ctx: AppContext, input: {
  runId: string; organizationId: string | null; actingUserId: string | null;
  swarmId?: string | null; sessionKey?: string; driver: SandboxDriver; cli: string;
  account: { id: string; provider: AccountProvider; reconnectRequired: boolean };
}) {
  if (!input.actingUserId || input.account.reconnectRequired) throw new Error("Reconnect your personal account under Agents.");
  const base = resolveGatewayBase(ctx, input.driver);
  if (!base) throw new Error("Personal account connections require a model proxy address reachable by the agent.");
  const grantToken = await mintRunGrant(ctx, { runId: input.runId, organizationId: input.organizationId,
    actingUserId: input.actingUserId, swarmId: input.swarmId ?? null, serverIds: [],
    modelCredentials: [personalKey(input.account.provider), personalMarker(input.account.id)], ttlMs: runGrantTtlMs(ctx) });
  const url = `${base.replace(/\/+$/, "")}${MODEL_PROXY_PATH}/${personalSegment(input.account.provider)}`;
  const token = subscriptionRunToken(grantToken, input.account.provider);
  const env: Record<string, string> = { BENTO_PERSONAL_PROVIDER: input.account.provider };
  if (input.cli === "pi") {
    // A separate config directory also works with local-process, without
    // replacing the person's own models.json or persisting provider tokens.
    env.ANTHROPIC_API_KEY = "";
    env.OPENAI_API_KEY = "";
    env.BENTO_PI_HOME = input.driver.provider === "local-process"
      ? `/tmp/bento-pi-${input.sessionKey ?? input.runId}` : "~/.pi/agent";
    // Sandboxes keep their normal Pi home, where Bento also installs MCP.
    if (input.driver.provider === "local-process") env.PI_CODING_AGENT_DIR = env.BENTO_PI_HOME;
    env.BENTO_PERSONAL_BASE_URL = url;
    env.BENTO_PERSONAL_RUN_TOKEN = token;
  } else if (input.account.provider === "anthropic") {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    env.ANTHROPIC_API_KEY = "";
    env.ANTHROPIC_AUTH_TOKEN = "";
    env.ANTHROPIC_BASE_URL = url;
  } else {
    env.OPENAI_API_KEY = grantToken;
    env.OPENAI_BASE_URL = url;
  }
  return { env, grantToken };
}
