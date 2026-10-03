import assert from "node:assert/strict";
import test from "node:test";
import { MODAL_REPO_PREPARE_TIMEOUT_MS } from "@bento/sandbox";
import { hibernateShouldSkip, MODAL_SWEEP_GRACE_MS } from "./hibernate-sandbox.js";
import { modalRunHosts } from "./modal-hosts.js";

test("hibernation skips anything that is not a finished modal sandbox", () => {
  assert.equal(hibernateShouldSkip(null, false), true);
  assert.equal(hibernateShouldSkip({ provider: "sprite", status: "busy" }, false), true);
  assert.equal(hibernateShouldSkip({ provider: "modal", status: "hibernated" }, false), true);
  assert.equal(hibernateShouldSkip({ provider: "modal", status: "destroyed" }, false), true);
  assert.equal(hibernateShouldSkip({ provider: "modal", status: "ready" }, true), true);
  assert.equal(hibernateShouldSkip({ provider: "modal", status: "ready" }, false), false);
  assert.equal(hibernateShouldSkip({ provider: "modal", status: "busy" }, false), false);
});

test("modal host collection keeps base URLs and drops secrets", () => {
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: ["git@github.com:acme/app.git", null],
    env: {
      ANTHROPIC_API_KEY: "secret-value",
      ANTHROPIC_BASE_URL: "https://api.example/v1",
      OPENAI_BASE_URL: "",
    },
    customBaseUrl: "https://models.example/v1",
  });
  assert.deepEqual(hosts, [
    "https://bento.example",
    "git@github.com:acme/app.git",
    "https://api.example/v1",
    "https://models.example/v1",
  ]);
  assert.equal(hosts.some((host) => host.includes("secret-value")), false);
  assert.equal(hosts.includes("https://api.anthropic.com"), false);
});

test("an API key with no base URL allowlists the default model host", () => {
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: ["https://github.com/acme/app.git"],
    env: { ANTHROPIC_API_KEY: "secret-value" },
  });
  assert.ok(hosts.includes("https://api.anthropic.com"));
  assert.equal(hosts.some((host) => host.includes("secret-value")), false);
});

test("a credential whose model host cannot be named refuses before a sandbox exists", () => {
  assert.throws(
    () =>
      modalRunHosts({
        gatewayUrl: "https://bento.example",
        cloneUrls: ["https://github.com/acme/app.git"],
        env: { SOME_VENDOR_API_KEY: "secret-value" },
      }),
    /model host for SOME_VENDOR_API_KEY could not be named/,
  );
});

test("orphan sweep grace outlasts a two repository clone", () => {
  assert.ok(MODAL_SWEEP_GRACE_MS > 2 * MODAL_REPO_PREPARE_TIMEOUT_MS);
  assert.ok(MODAL_SWEEP_GRACE_MS > 16 * 60 * 1000);
});
