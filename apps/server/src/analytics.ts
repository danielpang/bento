import { PostHog } from "posthog-node";
import type { Env } from "./env.js";

/**
 * A product event on its way to PostHog.
 *
 * Every event needs a distinct id, but plenty of server-side moments
 * have no acting user: a gate advanced a card, a run finished hours
 * after the click that started it. Callers pass the user when they
 * know one and the organization when they know that, and the fallback
 * chain below picks the best identity available rather than making
 * each call site invent one.
 */
export interface ServerEvent {
  event: string;
  /** The acting user, when one is known. */
  userId?: string | null;
  /** The tenant the event happened in; becomes a PostHog group. */
  organizationId?: string | null;
  properties?: Record<string, unknown>;
}

export interface Analytics {
  capture(event: ServerEvent): void;
  /** An error with its message and stack trace, for error tracking. */
  captureException(error: unknown, userId?: string | null, properties?: Record<string, unknown>): void;
  /** Flushes the queue; call on shutdown or events are lost. */
  shutdown(): Promise<void>;
}

/**
 * Builds the PostHog client, or null when no key is configured.
 *
 * Null rather than a stub, so `ctx.analytics?.capture(...)` reads the
 * same as the other optional context members (auth, githubApp) and a
 * deployment that never configures PostHog pays nothing per request.
 * The missing key is announced once outside production: an install
 * that meant to measure and is silently measuring nothing is the
 * failure mode this line exists to prevent.
 */
export function createAnalytics(env: Env): Analytics | null {
  if (!env.POSTHOG_API_KEY) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "POSTHOG_API_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_API_KEY is configured",
      );
    }
    return null;
  }

  const client = new PostHog(env.POSTHOG_API_KEY, {
    host: env.POSTHOG_HOST,
    // Uncaught exceptions and unhandled rejections, captured before
    // the process goes down.
    enableExceptionAutocapture: true,
  });
  // The SDK never throws into the caller; failures surface here.
  client.on("error", (err) => {
    console.warn("posthog client error:", err);
  });

  const mode = env.BENTO_MODE;

  return {
    capture({ event, userId, organizationId, properties }: ServerEvent): void {
      /**
       * A synthetic distinct id (the organization, or the server
       * itself) still counts the event, but must not mint a person
       * profile pretending to be someone.
       */
      const distinctId = userId ?? (organizationId ? `organization:${organizationId}` : "bento-server");
      client.capture({
        distinctId,
        event,
        properties: {
          bento_mode: mode,
          ...(userId ? {} : { $process_person_profile: false }),
          ...properties,
        },
        ...(organizationId ? { groups: { organization: organizationId } } : {}),
      });
    },

    captureException(error: unknown, userId?: string | null, properties?: Record<string, unknown>): void {
      client.captureException(error instanceof Error ? error : new Error(String(error)), userId ?? undefined, {
        bento_mode: mode,
        ...properties,
      });
    },

    async shutdown(): Promise<void> {
      await client.shutdown();
    },
  };
}
