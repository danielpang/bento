/**
 * Browser error tracking, using the same PostHog project as the server.
 *
 * The server already sends product events through posthog-node. This
 * module only captures exceptions: uncaught errors via the SDK, and
 * handled ones that call `captureException`. Product autocapture stays
 * off, so a console click does not mint a second stream of events.
 *
 * The project token comes from `/api/health`, which reads the existing
 * POSTHOG_API_KEY. That key is a public phc_ token; it is not a secret.
 * posthog-js is loaded only when a token is present, so a laptop with
 * no key pays nothing and a node test that imports this file never
 * constructs a browser client.
 */

type PostHogClient = {
  captureException: (error: unknown, properties?: Record<string, unknown>) => void;
  identify: (id: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
  register: (properties: Record<string, unknown>) => void;
};

let client: PostHogClient | null = null;

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  client?.captureException(error instanceof Error ? error : new Error(String(error)), properties);
}

export function identifyUser(
  userId: string,
  traits?: { email?: string | null; name?: string | null },
): void {
  if (!client) return;
  client.identify(userId, {
    ...(traits?.email ? { email: traits.email } : {}),
    ...(traits?.name ? { name: traits.name } : {}),
  });
}

export function resetUser(): void {
  client?.reset();
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
    if (!cfg?.apiKey) return;
    const { default: posthog } = await import("posthog-js");
    posthog.init(cfg.apiKey, {
      api_host: cfg.host || "https://us.i.posthog.com",
      capture_exceptions: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
    });
    posthog.register({
      environment: cfg.environment,
      bento_mode: body.mode,
    });
    client = posthog;
  } catch {
    // Error tracking is optional. A console that cannot reach the
    // server already has its own unreachable screen.
  }
}
