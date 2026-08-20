const SLACK_API = "https://slack.com/api";

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export interface SlackOAuthResult {
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
}

export interface SlackUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackOk {
  ok: boolean;
  error?: string;
}

/**
 * Minimal Slack Web API client. Bot tokens go in the Authorization
 * header; nothing here is part of an agent's environment.
 */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async postMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<SlackMessageRef> {
    const result = await this.call<{ channel?: string; ts?: string }>("chat.postMessage", {
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
    if (!result.channel || !result.ts) throw new SlackApiError("Slack did not return a message timestamp");
    return { channel: result.channel, ts: result.ts };
  }

  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<void> {
    await this.call("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
  }

  async postEphemeral(input: { channel: string; user: string; text: string }): Promise<void> {
    await this.call("chat.postEphemeral", {
      channel: input.channel,
      user: input.user,
      text: input.text,
    });
  }

  async openView(input: { triggerId: string; view: Record<string, unknown> }): Promise<void> {
    await this.call("views.open", { trigger_id: input.triggerId, view: input.view });
  }

  async usersInfo(userId: string): Promise<SlackUserInfo | null> {
    /**
     * users.info is a GET method. Posting JSON (the way chat.postMessage
     * works) leaves `user` unset, and Slack answers user_not_found even
     * for a member of the workspace.
     */
    try {
      const result = await this.get<{
        user?: { id?: string; name?: string; profile?: { email?: string; real_name?: string } };
      }>("users.info", { user: userId });
      if (!result.user?.id) return null;
      return {
        id: result.user.id,
        email: result.user.profile?.email ?? null,
        name: result.user.profile?.real_name ?? result.user.name ?? null,
      };
    } catch (err) {
      if (err instanceof SlackApiError && (err.code === "user_not_found" || err.code === "user_not_visible")) {
        return null;
      }
      throw err;
    }
  }

  private async get<T>(method: string, query: Record<string, string>): Promise<T & SlackOk> {
    const url = new URL(`${SLACK_API}/${method}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    return this.read(method, res);
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T & SlackOk> {
    const res = await this.fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return this.read(method, res);
  }

  private async read<T>(method: string, res: Response): Promise<T & SlackOk> {
    const json = (await res.json()) as T & SlackOk;
    if (!json.ok) throw new SlackApiError(json.error ?? `Slack ${method} failed`, json.error);
    return json;
  }
}

/**
 * Exchanges an OAuth code for a bot token. Uses the app credentials,
 * not a workspace token, so this lives outside SlackClient.
 */
export async function exchangeOAuthCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SlackOAuthResult> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const res = await fetchImpl(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as SlackOk & {
    access_token?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  };
  if (!json.ok || !json.access_token || !json.bot_user_id || !json.team?.id || !json.team.name) {
    throw new SlackApiError(json.error ?? "Slack OAuth did not return a bot token", json.error);
  }
  return {
    teamId: json.team.id,
    teamName: json.team.name,
    botUserId: json.bot_user_id,
    botToken: json.access_token,
  };
}

export const SLACK_BOT_SCOPES = ["app_mentions:read", "chat:write", "users:read", "users:read.email"] as const;

export function slackAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}
