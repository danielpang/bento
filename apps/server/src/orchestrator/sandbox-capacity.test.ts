import assert from "node:assert/strict";
import test from "node:test";
import { allAttemptsAtCapacity, isCapacityAttempt } from "./sandbox-capacity.js";
import { SandboxProvisionError, SANDBOX_UNAVAILABLE_MESSAGE } from "./sandbox-provision.js";
import { SANDBOX_CAPACITY_MESSAGE } from "@bento/core";
import { provisionFault } from "./run-fault.js";
import { infraFailureReason } from "../infra-failures.js";

const sprite = { provider: "sprite", phase: "acquire", reason: new Error("concurrent_sprite_limit_exceeded") };
const modal = { provider: "modal", phase: "create", reason: new Error("[resource_exhausted] Concurrent sandbox limit exceeded") };

test("both providers' concurrency ceilings are capacity, including wrapped SDK failures", () => {
  for (const attempt of [sprite, modal, { ...sprite, reason: new Error("max sprites per org exceeded") },
    { ...modal, reason: new Error("Exceeded container quota for workspace") },
    { ...modal, reason: new Error("wrapped", { cause: modal.reason }) }]) assert.equal(isCapacityAttempt(attempt), true);
});

test("rate limits, outages, billing, checkout failures and unrelated providers are not capacity", () => {
  for (const attempt of [
    { ...modal, reason: new Error("[resource_exhausted] API rate limit exceeded") },
    { ...sprite, reason: new Error("Failed to create sprite (status 429): too many requests") },
    { ...modal, reason: new Error("Payment required: budget exceeded") },
    { ...modal, reason: new Error("503 service unavailable") },
    { ...modal, phase: "checkout" }, { ...modal, blame: "project" }, { ...modal, provider: "docker" },
  ]) assert.equal(isCapacityAttempt(attempt), false);
  const cycle = new Error("unknown"); cycle.cause = cycle;
  assert.equal(isCapacityAttempt({ ...modal, reason: cycle }), false);
});

test("only all eligible providers being full produces the friendly, unbilled error", () => {
  for (const failures of [[sprite], [modal], [sprite, modal]]) {
    assert.equal(allAttemptsAtCapacity(failures), true);
    const error = new SandboxProvisionError("provider", failures, modal.reason);
    assert.equal(error.message, SANDBOX_CAPACITY_MESSAGE);
    assert.equal(provisionFault(error), "sandbox");
    assert.equal(infraFailureReason(`sandbox provisioning failed: ${error.message}`)?.id, "sandbox-capacity");
  }
  assert.equal(allAttemptsAtCapacity([]), false);
  const failures = [sprite, { ...modal, reason: new Error("network down") }];
  assert.equal(new SandboxProvisionError("provider", failures, failures[1]!.reason).message, SANDBOX_UNAVAILABLE_MESSAGE);
});
