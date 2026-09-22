/**
 * Browser error tracking and identity, using the same PostHog project
 * as the server and the marketing site.
 *
 * The server already sends product events through posthog-node. This
 * module captures exceptions (uncaught via the SDK, handled via
 * `captureException`) and aliases the marketing-site anonymous
 * distinct_id onto the signed-in user. Product autocapture stays off,
 * so a console click does not mint a second stream of events.
 *
 * The project token comes from `/api/health`, which only includes it
 * in multi mode when POSTHOG_API_KEY is set. That key is a public
 * phc_ token; it is not a secret. posthog-js is loaded only when a
 * token is present and the server is not in local mode, so a laptop
 * pays nothing and a node test that imports this file never
 * constructs a browser client.
 */

/**
 * Persistence both hosts must share so a visit on usebento.ai and a
 * signup on app.usebento.ai stay one person. The cookie is set on
 * `.usebento.ai`; when localStorage already has a stale app id, the
 * shared cookie wins.
 */
export const BROWSER_PERSISTENCE = {
  persistence: "localStorage+cookie",
  cross_subdomain_cookie: true,
  cookieWinsOnConflict: true,
} as const;

type PostHogClient = {
  captureException: (error: unknown, properties?: Record<string, unknown>) => void;
  identify: (id: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
  register: (properties: Record<string, unknown>) => void;
};

type SessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type IdentityRequest =
  | { type: "identify"; userId: string; properties: Record<string, string> }
  | { type: "reset" };

let client: PostHogClient | null = null;
let pending: IdentityRequest | null = null;

/**
 * What to do when the session hook settles.
 *
 * An anonymous hop from the marketing site must not reset(): that
 * would mint a new distinct_id and overwrite the shared cookie.
 * Reset only after a signed-in user leaves.
 */
export function sessionIdentityChange(
  previousUserId: string | null,
  user: SessionUser | null,
): { type: "identify"; user: SessionUser } | { type: "reset" } | { type: "none" } {
  if (user) return { type: "identify", user };
  if (previousUserId) return { type: "reset" };
  return { type: "none" };
}

/**
 * Whether the console should load posthog-js from a /api/health body.
 *
 * Local mode is a hard no, even if a leftover key leaked onto the
 * payload: people running Bento on a laptop must not send exceptions
 * into the hosted project. Multi mode without a token is also a no.
 */
export function shouldStartErrorTracking(health: {
  mode?: string;
  posthog?: { apiKey?: string | null };
}): boolean {
  if (health.mode !== "multi") return false;
  return Boolean(health.posthog?.apiKey?.trim());
}

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  client?.captureException(error instanceof Error ? error : new Error(String(error)), properties);
}

function identityProperties(traits?: { email?: string | null; name?: string | null }): Record<string, string> {
  return {
    ...(traits?.email ? { email: traits.email } : {}),
    ...(traits?.name ? { name: traits.name } : {}),
  };
}

function applyIdentity(target: PostHogClient, request: IdentityRequest): void {
  if (request.type === "reset") {
    target.reset();
    return;
  }
  target.identify(request.userId, request.properties);
}

export function identifyUser(
  userId: string,
  traits?: { email?: string | null; name?: string | null },
): void {
  const request: IdentityRequest = { type: "identify", userId, properties: identityProperties(traits) };
  if (!client) {
    pending = request;
    return;
  }
  applyIdentity(client, request);
}

export function resetUser(): void {
  if (!client) {
    pending = { type: "reset" };
    return;
  }
  pending = null;
  client.reset();
}

function attachClient(next: PostHogClient): void {
  client = next;
  if (!pending) return;
  applyIdentity(client, pending);
  pending = null;
}

/**
 * Loads the public token from the server and turns on exception
 * autocapture. Safe to call more than once; a second call is a no-op.
 * A down server or a deployment with no key leaves capturing off.
 */
export async function startErrorTracking(): Promise<void> {
  if (client || typeof window === "undefined") return;
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const body = (await res.json()) as {
      mode?: string;
      posthog?: { apiKey: string; host: string; environment: string };
    };
    const cfg = body.posthog;
    if (!shouldStartErrorTracking(body) || !cfg?.apiKey) return;
    const { default: posthog } = await import("posthog-js");
    posthog.init(cfg.apiKey, {
      api_host: cfg.host || "https://us.i.posthog.com",
      capture_exceptions: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      ...BROWSER_PERSISTENCE,
    });
    posthog.register({
      environment: cfg.environment,
      bento_mode: body.mode,
    });
    attachClient(posthog);
  } catch {
    // Error tracking is optional. A console that cannot reach the
    // server already has its own unreachable screen.
  }
}
