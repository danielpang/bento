export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowOptions {
  baseUrl: string;
  clientId: string;
  fetch?: typeof fetch;
  /** Called once the user-facing code is available, so the CLI can print it. */
  onPrompt?: (info: DeviceCodeResponse) => void;
  signal?: AbortSignal;
}

/**
 * OAuth 2.0 device authorization flow (RFC 8628), the login shape used
 * by CLIs: print a short code, the user approves it in a browser, the
 * CLI polls until it receives a token.
 */
export class DeviceFlow {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(private options: DeviceFlowOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    // Must be bound: an unbound window.fetch throws "Illegal invocation".
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async requestCode(): Promise<DeviceCodeResponse> {
    // better-auth's device endpoints take JSON, not the form encoding
    // RFC 8628 specifies. Sending form data returns UNSUPPORTED_MEDIA_TYPE.
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.options.clientId, scope: "board" }),
    });
    if (!res.ok) {
      // The body here is whatever the server felt like sending, often
      // an HTML error page, and pasting it into a terminal tells a
      // person nothing they can act on. The status does.
      throw new Error(
        res.status === 404
          ? `${this.baseUrl} did not offer a login. Check the address, and that it is a Bento server.`
          : `${this.baseUrl} refused to start a login (HTTP ${res.status}).`,
      );
    }
    const data = (await res.json()) as DeviceCodeResponse;
    this.options.onPrompt?.(data);
    return data;
  }

  /**
   * Polls until the user approves. Per RFC 8628, authorization_pending
   * means keep waiting and slow_down means back off; anything else is
   * terminal.
   */
  async pollForToken(code: DeviceCodeResponse): Promise<string> {
    let intervalMs = Math.max(code.interval, 1) * 1000;
    const deadline = Date.now() + code.expires_in * 1000;

    while (Date.now() < deadline) {
      if (this.options.signal?.aborted) throw new Error("login cancelled");
      await sleep(intervalMs);

      const res = await this.fetchImpl(`${this.baseUrl}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: this.options.clientId,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (res.ok && body.access_token) return body.access_token;

      switch (body.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          intervalMs += 5000;
          continue;
        case "access_denied":
          throw new Error("login was denied");
        case "expired_token":
          throw new Error("login code expired, start again");
        default:
          throw new Error(body.error_description ?? body.error ?? `unexpected response ${res.status}`);
      }
    }
    throw new Error("login timed out");
  }

  /** Convenience: request a code, prompt, and wait for approval. */
  async login(): Promise<string> {
    return this.pollForToken(await this.requestCode());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
