import { PostHog } from "posthog-node";
import { posthogApiKey, type Env } from "./env.js";

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
  captureException(
    error: unknown,
    userId?: string | null,
    organizationId?: string | null,
    properties?: Record<string, unknown>,
  ): void;
  /** Flushes the queue and removes process listeners; call on shutdown. */
  shutdown(): Promise<void>;
}

/**
 * How long a shutdown flush may take. The process's own shutdown
 * deadline is ten seconds (see index.ts), and the SDK's default budget
 * is thirty: left alone, a PostHog outage during a deploy would turn
 * every graceful stop into the hard kill the deadline exists to avoid.
 */
const FLUSH_BUDGET_MS = 2000;

/**
 * Wraps a pg-boss handler so a throw reaches error tracking before
 * pg-boss absorbs it into a retry. The orchestrator's jobs are where
 * this server does most of its work, and an error the queue handles is
 * never an uncaught exception, so without this it would leave no trace
 * beyond a log line.
 */
export function captureJobErrors<Args extends unknown[]>(
  analytics: Analytics | undefined,
  queue: string,
  handler: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await handler(...args);
    } catch (err) {
      analytics?.captureException(err, null, null, { queue });
      throw err;
    }
  };
}

/**
 * Builds the PostHog client, or null when this process must not send.
 *
 * Null rather than a stub, so `ctx.analytics?.capture(...)` reads the
 * same as the other optional context members (auth, githubApp) and a
 * deployment that never configures PostHog pays nothing per request.
 * Quietly null: the announcement that analytics is off belongs to
 * server.ts beside the artifact-bucket warning, where it can respect
 * the deployment mode and the quiet flag, which this factory cannot
 * see. Local mode is always null, even with a leftover key.
 */
export function createAnalytics(env: Env): Analytics | null {
  const apiKey = posthogApiKey(env);
  if (!apiKey) return null;

  /**
   * Exception autocapture registers process-level listeners that the
   * SDK never removes. Snapshot around construction so shutdown can
   * take them back out: the e2e suite and the embedded TUI start and
   * stop servers in one process, and each leaked listener is another
   * handler racing to exit the process on a crash.
   */
  const beforeException = new Set(process.listeners("uncaughtException"));
  const beforeRejection = new Set(process.listeners("unhandledRejection"));

  const client = new PostHog(apiKey, {
    host: env.POSTHOG_HOST,
    // Uncaught exceptions, captured before the process goes down.
    enableExceptionAutocapture: true,
  });

  const addedException = process.listeners("uncaughtException").filter((l) => !beforeException.has(l));
  const addedRejection = process.listeners("unhandledRejection").filter((l) => !beforeRejection.has(l));

  // The SDK never throws into the caller; failures surface here.
  client.on("error", (err) => {
    console.warn("posthog client error:", err);
  });

  const mode = env.BENTO_MODE;
  const environment = env.BENTO_ENVIRONMENT;

  /**
   * Super properties ride on every event this client captures,
   * including the exceptions its own autocapture handler reports,
   * which never pass through the wrappers below. The wrappers still
   * set both explicitly, so an event cannot lose them to the register
   * call's timing.
   */
  void client.register({ environment, bento_mode: mode });

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
          environment,
          bento_mode: mode,
          ...(userId ? {} : { $process_person_profile: false }),
          ...properties,
        },
        ...(organizationId ? { groups: { organization: organizationId } } : {}),
      });
    },

    captureException(
      error: unknown,
      userId?: string | null,
      organizationId?: string | null,
      properties?: Record<string, unknown>,
    ): void {
      /**
       * The same identity rule as capture. Left empty, the SDK invents
       * a distinct id per exception, so an issue hit ten times by
       * nobody in particular reported ten people affected.
       */
      const distinctId = userId ?? (organizationId ? `organization:${organizationId}` : "bento-server");
      client.captureException(error instanceof Error ? error : new Error(String(error)), distinctId, {
        environment,
        bento_mode: mode,
        ...(userId ? {} : { $process_person_profile: false }),
        // The event-level group property, so error tracking can answer
        // "which tenant is this hitting".
        ...(organizationId ? { $groups: { organization: organizationId } } : {}),
        ...properties,
      });
    },

    async shutdown(): Promise<void> {
      for (const listener of addedException) process.removeListener("uncaughtException", listener);
      for (const listener of addedRejection) process.removeListener("unhandledRejection", listener);
      await client.shutdown(FLUSH_BUDGET_MS);
    },
  };
}
