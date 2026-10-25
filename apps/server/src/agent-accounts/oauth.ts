import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const accountProvider = z.enum(["anthropic", "openai-codex"]);
export type AccountProvider = z.infer<typeof accountProvider>;
export interface AccountTokens { access: string; refresh: string; expires: number; accountId?: string }
export interface LoginState { verifier?: string; state?: string; deviceId?: string; userCode?: string; interval: number }
const OPENAI_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const OPENAI = "https://auth.openai.com";
const CLAUDE_TOKEN = "https://platform.claude.com/v1/oauth/token";

/** Never include provider response bodies, codes, or tokens in exceptions. */
export class AccountLoginError extends Error {
  constructor(message = "Account login failed. Please reconnect.", readonly permanent = false) { super(message); }
}
export type OAuthFetch = typeof fetch;
async function post(url: string, body: Record<string, string>, form: boolean, fetcher: OAuthFetch) {
  try {
    return await fetcher(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
  } catch { throw new AccountLoginError("Could not reach the login provider. Please try again."); }
}
const tokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive().finite() });
export function chatgptAccountId(access: string): string {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString());
    const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch { /* Tokens come directly from the provider, never from the browser. */ }
  throw new AccountLoginError("The login provider did not return a ChatGPT account.");
}
async function tokens(provider: AccountProvider, response: Response): Promise<AccountTokens> {
  if (!response.ok) throw new AccountLoginError("Account authorization failed. Please reconnect.", response.status === 400 || response.status === 401);
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AccountLoginError("The login provider returned an invalid response.");
  const value = parsed.data;
  return {
    access: value.access_token, refresh: value.refresh_token, expires: Date.now() + value.expires_in * 1000,
    ...(provider === "openai-codex" ? { accountId: chatgptAccountId(value.access_token) } : {}),
  };
}

/** Matches Pi's copy-code flow and Codex's JSON device-code endpoints. */
export async function beginLogin(provider: AccountProvider, fetcher: OAuthFetch = fetch) {
  if (provider === "anthropic") {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      code: "true", client_id: CLAUDE_CLIENT, response_type: "code", redirect_uri: CLAUDE_REDIRECT,
      scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
    });
    return { state: { verifier, state, interval: 0 } satisfies LoginState, url: `https://claude.ai/oauth/authorize?${query}`, userCode: null, interval: 0 };
  }
  const response = await post(`${OPENAI}/api/accounts/deviceauth/usercode`, { client_id: OPENAI_CLIENT }, false, fetcher);
  if (!response.ok) throw new AccountLoginError("Could not start ChatGPT login. Check that device-code login is enabled for your account.");
  const parsed = z.object({ device_auth_id: z.string().min(1), user_code: z.string().min(1), interval: z.coerce.number().finite().nonnegative() }).safeParse(await response.json());
  if (!parsed.success) throw new AccountLoginError("The login provider returned an invalid response.");
  const interval = Math.max(5, parsed.data.interval);
  return { state: { deviceId: parsed.data.device_auth_id, userCode: parsed.data.user_code, interval } satisfies LoginState,
    url: `${OPENAI}/codex/device`, userCode: parsed.data.user_code, interval };
}

export async function completeLogin(provider: AccountProvider, state: LoginState, code?: string, fetcher: OAuthFetch = fetch): Promise<AccountTokens | null> {
  if (provider === "anthropic") {
    // Require the state as well as the code. A code for a different attempt
    // must never connect an account to the currently signed-in person.
    const [authorization, returnedState] = (code ?? "").trim().split("#");
    if (!authorization || !state.verifier || returnedState !== state.state) throw new AccountLoginError("Paste the complete code, including the part after #, from this login attempt.");
    return tokens(provider, await post(CLAUDE_TOKEN, { grant_type: "authorization_code", client_id: CLAUDE_CLIENT,
      code: authorization, state: state.state!, code_verifier: state.verifier, redirect_uri: CLAUDE_REDIRECT }, false, fetcher));
  }
  const response = await post(`${OPENAI}/api/accounts/deviceauth/token`, { device_auth_id: state.deviceId!, user_code: state.userCode! }, false, fetcher);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string | { code?: string } } | null;
    const error = typeof data?.error === "string" ? data.error : data?.error?.code;
    if (error === "deviceauth_authorization_pending") return null;
    if (error === "slow_down") { state.interval += 5; return null; }
    throw new AccountLoginError("ChatGPT login failed or expired. Start a new connection.");
  }
  const parsed = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) }).safeParse(await response.json());
  if (!parsed.success) throw new AccountLoginError();
  return tokens(provider, await post(`${OPENAI}/oauth/token`, { grant_type: "authorization_code", client_id: OPENAI_CLIENT,
    code: parsed.data.authorization_code, code_verifier: parsed.data.code_verifier, redirect_uri: `${OPENAI}/deviceauth/callback` }, true, fetcher));
}

export async function refreshLogin(provider: AccountProvider, refresh: string, fetcher: OAuthFetch = fetch) {
  return tokens(provider, await post(provider === "anthropic" ? CLAUDE_TOKEN : `${OPENAI}/oauth/token`, {
    grant_type: "refresh_token", client_id: provider === "anthropic" ? CLAUDE_CLIENT : OPENAI_CLIENT, refresh_token: refresh,
  }, provider === "openai-codex", fetcher));
}
