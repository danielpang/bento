import { test } from "node:test";
import assert from "node:assert/strict";
import { betaByChoice, createFeatureFlags, FeatureFlags, FLAGS, type FlagEvaluator } from "./feature-flags.js";
import { loadEnv } from "./env.js";

function evaluator(
  enabled: Record<string, boolean>,
  options?: { hang?: boolean; fail?: Error },
): FlagEvaluator & { calls: Array<{ flag: string; distinctId: string; email?: string }> } {
  const calls: Array<{ flag: string; distinctId: string; email?: string }> = [];
  return {
    calls,
    async evaluateFlags(distinctId, opts) {
      if (options?.fail) throw options.fail;
      if (options?.hang) await new Promise(() => {});
      const flag = opts?.flagKeys?.[0] ?? FLAGS.BETA_TESTERS;
      calls.push({
        flag,
        distinctId,
        ...(typeof opts?.personProperties?.email === "string" ? { email: opts.personProperties.email } : {}),
      });
      return { isEnabled: (key) => enabled[key] === true };
    },
    async shutdown() {},
  };
}

test("local mode is on until the person turns it off, even without a PostHog key", async () => {
  const flags = createFeatureFlags(loadEnv({ BENTO_MODE: "local" }));
  assert.equal(await flags.isBetaTester("anyone"), true);
  assert.deepEqual(await flags.snapshot("anyone"), { betaTesters: true });
});

test("local mode with a leftover key still never calls PostHog", async () => {
  const flags = createFeatureFlags(
    loadEnv({ BENTO_MODE: "local", POSTHOG_API_KEY: "phc_leftover_from_hosted" }),
  );
  assert.equal(flags.usesPostHog(), false);
  assert.equal(await flags.isBetaTester("anyone"), true);
});

test("multi mode without a key does not construct a client", () => {
  const flags = createFeatureFlags(loadEnv({ BENTO_MODE: "multi" }));
  assert.equal(flags.usesPostHog(), false);
});

test("multi mode without a key fails closed", async () => {
  const flags = createFeatureFlags(loadEnv({ BENTO_MODE: "multi" }));
  assert.equal(await flags.isBetaTester("user-1", { email: "a@b.test" }), false);
  assert.deepEqual(await flags.snapshot("user-1"), { betaTesters: false });
});

test("a user on the allowlist is a beta tester", async () => {
  const flags = new FeatureFlags(evaluator({ [FLAGS.BETA_TESTERS]: true }), false);
  assert.equal(await flags.isBetaTester("user-1", { email: "a@b.test" }), true);
});

test("a user off the allowlist is not a beta tester", async () => {
  const flags = new FeatureFlags(evaluator({ [FLAGS.BETA_TESTERS]: false }), false);
  assert.equal(await flags.isBetaTester("user-1"), false);
});

test("evaluation passes the user id and email through to PostHog", async () => {
  const stub = evaluator({ [FLAGS.BETA_TESTERS]: true });
  const flags = new FeatureFlags(stub, false);
  await flags.isBetaTester("user-1", { email: "a@b.test" });
  assert.deepEqual(stub.calls, [{ flag: FLAGS.BETA_TESTERS, distinctId: "user-1", email: "a@b.test" }]);
});

test("always-on skips the evaluator entirely", async () => {
  const stub = evaluator({ [FLAGS.BETA_TESTERS]: false });
  const flags = new FeatureFlags(stub, true);
  assert.equal(await flags.isBetaTester("user-1"), true);
  assert.equal(stub.calls.length, 0);
});

test("a thrown evaluation fails closed", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const flags = new FeatureFlags(evaluator({}, { fail: new Error("posthog down") }), false);
    assert.equal(await flags.isBetaTester("user-1"), false);
  } finally {
    console.warn = warn;
  }
});

test("a slow evaluation fails closed inside the budget", async () => {
  const flags = new FeatureFlags(evaluator({ [FLAGS.BETA_TESTERS]: true }, { hang: true }), false, 50);
  const began = Date.now();
  assert.equal(await flags.isBetaTester("user-1"), false);
  assert.ok(Date.now() - began < 500, "must not wait out a hung evaluator");
});

test("a person's own choice decides before PostHog does", () => {
  // Local: on unless they chose off.
  assert.equal(betaByChoice(true, null), true);
  assert.equal(betaByChoice(true, true), true);
  assert.equal(betaByChoice(true, false), false);
  // Multi: on wins; anything else leaves the flag to decide.
  assert.equal(betaByChoice(false, true), true);
  assert.equal(betaByChoice(false, false), null);
  assert.equal(betaByChoice(false, null), null);
});

test("opting in overrides a PostHog flag that says no, without asking it", async () => {
  const stub = evaluator({ [FLAGS.BETA_TESTERS]: false });
  const flags = new FeatureFlags(stub, false);
  assert.equal(await flags.isBetaTester("user-1", { email: "a@b.test", betaFeatures: true }), true);
  assert.equal(stub.calls.length, 0);
});

test("opting in overrides a multi deployment without a PostHog key", async () => {
  const flags = createFeatureFlags(loadEnv({ BENTO_MODE: "multi" }));
  assert.equal(await flags.isBetaTester("user-1", { betaFeatures: true }), true);
});

test("in multi mode the switch off leaves a beta tester on the flag", async () => {
  const flags = new FeatureFlags(evaluator({ [FLAGS.BETA_TESTERS]: true }), false);
  assert.equal(await flags.isBetaTester("user-1", { betaFeatures: false }), true);
});

test("in local mode the switch off turns beta off", async () => {
  const flags = createFeatureFlags(loadEnv({ BENTO_MODE: "local" }));
  assert.equal(await flags.isBetaTester("anyone", { betaFeatures: false }), false);
  assert.deepEqual(await flags.snapshot("anyone", { betaFeatures: false }), { betaTesters: false });
});
