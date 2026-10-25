import assert from "node:assert/strict";
import test from "node:test";
import { localSettings, localSettingsChanged } from "./local-settings.js";

const running = { dataDir: "/Users/me/.bento", databaseUrl: "", sandbox: "docker", sandboxImage: "bento-sandbox:dev", betaFeatures: false, modelProxy: true } as const;

test("the same settings reopen the running local Bento", () => {
  assert.equal(localSettingsChanged(running, { ...running }), false);
  assert.equal(localSettingsChanged(running, { ...running, dataDir: " /Users/me/.bento " }), false);
});

test("any setting local Bento starts with restarts it", () => {
  assert.equal(localSettingsChanged(running, { ...running, betaFeatures: true }), true);
  assert.equal(localSettingsChanged(running, { ...running, modelProxy: false }), true);
  assert.equal(localSettingsChanged(running, { ...running, sandbox: "local-process" }), true);
  assert.equal(localSettingsChanged(running, { ...running, sandboxImage: "other:1" }), true);
  assert.equal(localSettingsChanged(running, { ...running, databaseUrl: "postgres://x/y" }), true);
});

test("localSettings keeps only what local Bento starts with", () => {
  assert.deepEqual(localSettings({ ...running, mode: "local", serverUrl: "https://example.com" } as never), running);
});
