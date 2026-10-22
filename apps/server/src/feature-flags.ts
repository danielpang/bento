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
 * Local mode is on unless the person turned it off. There is one
 * trusted user and no tenant boundary, so a laptop install must not
 * hide the thing being built from someone who has not said otherwise.
 *
 * Each person can also choose for themselves (`identity.user.beta_features`,
 * from Settings, Account, or the Mac app's first screen): true turns
 * beta on in either mode, whatever PostHog says; false turns it off in
 * local mode and, in multi mode, leaves PostHog to decide. `betaByChoice`
 * is that rule, and every beta check goes through it.
 */
export const FLAGS = {
  BETA_TESTERS: "beta-testers",
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

/** Who a beta check is about: what PostHog matches on, and their own choice. */
export interface BetaPerson {
  email?: string | null;
  /** `identity.user.beta_features`: null until they choose. */
  betaFeatures?: boolean | null;
}

/**
 * What a person's own choice decides, or null when it leaves the answer
 * to PostHog. A choice of true always wins; local mode is on unless
 * they chose false; multi mode without a true choice asks PostHog.
 */
export function betaByChoice(local: boolean, choice: boolean | null | undefined): boolean | null {
  if (local) return choice !== false;
  return choice === true ? true : null;
}

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

  /**
   * Whether beta is on for this user: their own choice when it decides
   * (`betaByChoice`), else the permanent beta-testers allowlist.
   */
  async isBetaTester(userId: string, person?: BetaPerson): Promise<boolean> {
    const chosen = betaByChoice(this.alwaysOn, person?.betaFeatures);
    if (chosen !== null) return chosen;
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

  async snapshot(userId: string, person?: BetaPerson): Promise<{ betaTesters: boolean }> {
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
  const person = await betaPerson(ctx, userId);
  if (!(await isBetaPerson(ctx, userId, person))) return null;
  return { userId, email: person.email };
}

/** The email and the beta choice of one user, for a beta check about them. */
export async function betaPerson(
  ctx: AppContext,
  userId: string,
): Promise<{ email: string | null; betaFeatures: boolean | null }> {
  const [row] = await ctx.db
    .select({ email: user.email, betaFeatures: user.betaFeatures })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return { email: row?.email ?? null, betaFeatures: row?.betaFeatures ?? null };
}

/**
 * Whether beta is on for a user already looked up. Without a flags
 * object (tests, or a caller that built none) the choice still decides,
 * and what is left undecided is off in multi mode, as it fails closed.
 */
export async function isBetaPerson(ctx: AppContext, userId: string, person: BetaPerson): Promise<boolean> {
  if (ctx.featureFlags) return ctx.featureFlags.isBetaTester(userId, person);
  return betaByChoice(ctx.env.BENTO_MODE !== "multi", person.betaFeatures) ?? false;
}

/**
 * Whether unfinished product is on for one agent run.
 *
 * A run has no session and not always a person: the console and the
 * API start one as somebody, the gate evaluator and the schedules
 * start one as nobody. So it asks about the acting member when there
 * is one, and about the project's owner when there is not. It is their
 * board either way, and it means a team's auto-started stages behave
 * the same as the runs they start by hand, which is the whole point of
 * a per-team allowlist.
 *
 * Fails closed, like every other flag read: a run that cannot reach
 * PostHog runs without the unfinished capability rather than with it.
 */
export async function isBetaRun(
  ctx: AppContext,
  input: { actingUserId: string | null; projectOwnerId: string },
): Promise<boolean> {
  const userId = input.actingUserId ?? input.projectOwnerId;
  return isBetaPerson(ctx, userId, await betaPerson(ctx, userId));
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

/**
 * Runs as a caller may read them. Which provider ran a run is Bento's
 * business and not the card's: the console shows it to beta testers
 * only, and the field is dropped here for everyone else, so the API is
 * not a way around the console.
 */
export async function runsForCaller<T extends { sandboxProvider?: string | null; sandboxExecution?: unknown }>(
  ctx: AppContext,
  c: Context,
  runs: T[],
): Promise<T[]> {
  if (runs.length === 0) return runs;
  const beta = await getBetaTester(ctx, c);
  // Native process identity is recovery bookkeeping, not part of the run API.
  // In particular its nested provider must not bypass the beta-only field.
  return runs.map(({ sandboxExecution: _execution, ...run }) => {
    if (beta) return run as T;
    const { sandboxProvider: _provider, ...rest } = run;
    return rest as T;
  });
}
