import { PostHog } from "posthog-node";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { user } from "@bento/db";
import { posthogApiKey, type Env } from "./env.js";
import type { AppContext } from "./context.js";
import { actor } from "./middleware/actor.js";

/**
 * Permanent PostHog flags this server evaluates.
 *
 * `beta-testers` is the allowlist for unfinished product: a feature
 * that is not ready for every signed-in user renders only for people
 * whose email is on that flag. Add or remove people in PostHog by
 * editing the flag's release conditions. The key never changes.
 *
 * Local mode is always on. There is one trusted user and no tenant
 * boundary, so a laptop install must not hide the thing being built.
 */
export const FLAGS = {
  BETA_TESTERS: "beta-testers",
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

/**
 * The PostHog surface this module needs. Narrower than the SDK so
 * tests can stub evaluation without constructing a client, and so a
 * future flags host does not have to look like posthog-node.
 */
export interface FlagEvaluator {
  evaluateFlags(
    distinctId: string,
    options?: { flagKeys?: string[]; personProperties?: Record<string, string> },
  ): Promise<{ isEnabled(key: string): boolean }>;
  shutdown(): Promise<void>;
}

export class FeatureFlags {
  /**
   * How long a PostHog round trip may take before the check fails
   * closed. The flags endpoint is on the console's first paint, and
   * an outage must not stall it for the SDK's default budget.
   */
  static readonly EVALUATE_BUDGET_MS = 2000;

  constructor(
    private readonly evaluator: FlagEvaluator | null,
    private readonly alwaysOn: boolean,
    private readonly budgetMs = FeatureFlags.EVALUATE_BUDGET_MS,
  ) {}

  /** True when this instance holds a PostHog client. */
  usesPostHog(): boolean {
    return this.evaluator !== null;
  }

  /** Whether this user is on the permanent beta-testers allowlist. */
  isBetaTester(userId: string, person?: { email?: string | null }): Promise<boolean> {
    return this.isEnabled(FLAGS.BETA_TESTERS, userId, person);
  }

  async isEnabled(flag: FlagKey, userId: string, person?: { email?: string | null }): Promise<boolean> {
    if (this.alwaysOn) return true;
    if (!this.evaluator) return false;
    const personProperties = person?.email ? { email: person.email } : undefined;
    try {
      const snapshot = await withBudget(
        this.evaluator.evaluateFlags(userId, {
          flagKeys: [flag],
          ...(personProperties ? { personProperties } : {}),
        }),
        this.budgetMs,
      );
      if (!snapshot) return false;
      return snapshot.isEnabled(flag);
    } catch (err) {
      console.warn("feature flag evaluation failed:", err);
      return false;
    }
  }

  async snapshot(userId: string, person?: { email?: string | null }): Promise<{ betaTesters: boolean }> {
    return { betaTesters: await this.isBetaTester(userId, person) };
  }

  async shutdown(): Promise<void> {
    await this.evaluator?.shutdown();
  }
}

/**
 * Builds the evaluator, or a flags object that never calls PostHog.
 *
 * Local mode is always on and never constructs a client, even if a
 * leftover POSTHOG_API_KEY is in the environment. Multi mode without
 * a key fails closed, so a hosted deployment that has not configured
 * PostHog does not leak unfinished UI to every signed-in user.
 */
export function createFeatureFlags(env: Env): FeatureFlags {
  const alwaysOn = env.BENTO_MODE !== "multi";
  const apiKey = posthogApiKey(env);
  if (!apiKey) return new FeatureFlags(null, alwaysOn);

  const client = new PostHog(apiKey, {
    host: env.POSTHOG_HOST,
  });
  client.on("error", (err) => {
    console.warn("posthog feature flag client error:", err);
  });
  return new FeatureFlags(client, alwaysOn);
}

/**
 * The acting user when they are a beta tester, or null.
 *
 * Beta endpoints that a non-tester must not learn about treat null as
 * 404, the same convention as the access helpers. GET /api/flags is
 * the exception: the console has to hear "no" in order to hide the UI.
 */
export async function getBetaTester(
  ctx: AppContext,
  c: Context,
): Promise<{ userId: string; email: string | null } | null> {
  const userId = actor(c);
  const [row] = await ctx.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const email = row?.email ?? null;
  const allowed = ctx.featureFlags
    ? await ctx.featureFlags.isBetaTester(userId, { email })
    : ctx.env.BENTO_MODE !== "multi";
  if (!allowed) return null;
  return { userId, email };
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
