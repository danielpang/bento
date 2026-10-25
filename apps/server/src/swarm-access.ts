import { eq } from "drizzle-orm";
import type { SwarmAccessState } from "@bento/core";
import { user } from "@bento/db";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "./context.js";
import { actor } from "./middleware/actor.js";

/**
 * The PostHog flag that lets a person run swarms on Bento's own
 * sandboxes. Its release condition matches the person property `email`,
 * so a person is let in by adding their email to the flag.
 */
export const HOSTED_SWARMS_FLAG = "hosted-swarms";

/** The person properties the flag is evaluated with. */
export interface SwarmFlagPerson {
  email: string;
}

const ANSWER_TTL_MS = 60_000;
/** A flag PostHog could not answer is asked again sooner. */
const FAILURE_TTL_MS = 10_000;
const FLAG_TIMEOUT_MS = 3_000;
const MAX_CACHED = 10_000;

/** A per-process cache whose entries expire and whose size is capped. */
class ExpiringCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires > Date.now()) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    if (this.entries.size >= MAX_CACHED) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

const answers = new ExpiringCache<SwarmAccessState>();

/** Drops every cached answer, so a test can change what PostHog says. */
export function forgetSwarmAccess(): void {
  answers.clear();
}

/**
 * Whether this person may run swarms, or is shown the waitlist.
 *
 * Local Bento runs swarms on the person's own machine, so it is always
 * open. A hosted server asks PostHog, because every swarm there runs on
 * sandboxes Bento pays for. A server with no PostHog key is somebody's
 * own install on their own sandboxes, and is open too. A flag PostHog
 * could not answer in time is the waitlist.
 *
 * Answers are cached per person, so the routes that ask inside a tenant
 * transaction read the answer `warmSwarmAccess` fetched before it.
 */
export async function swarmAccessFor(ctx: AppContext, userId: string): Promise<SwarmAccessState> {
  if (ctx.env.BENTO_MODE !== "multi") return "open";
  const isFeatureEnabled = ctx.analytics?.isFeatureEnabled;
  if (!isFeatureEnabled) return "open";

  const cached = answers.get(userId);
  if (cached) return cached;

  const [person] = await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  if (!person) return "waitlist";
  const properties: SwarmFlagPerson = { email: person.email };
  try {
    const enabled = await withTimeout(
      isFeatureEnabled.call(ctx.analytics, HOSTED_SWARMS_FLAG, userId, { ...properties }),
      FLAG_TIMEOUT_MS,
    );
    if (enabled === undefined) throw new Error("PostHog did not answer");
    const state: SwarmAccessState = enabled ? "open" : "waitlist";
    answers.set(userId, state, ANSWER_TTL_MS);
    return state;
  } catch (err) {
    console.warn(`[swarms] ${HOSTED_SWARMS_FLAG} could not be evaluated for user ${userId}:`, err);
    answers.set(userId, "waitlist", FAILURE_TTL_MS);
    return "waitlist";
  }
}

/**
 * Asks before the tenant transaction opens, for the routes that check
 * swarm access inside one, so the PostHog round trip never holds a
 * pooled connection. They then read the cached answer.
 */
export function warmSwarmAccess(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    if (/^\/api\/(swarms|runs|artifacts)(\/|$)/.test(c.req.path)) await swarmAccessFor(ctx, actor(c));
    await next();
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
