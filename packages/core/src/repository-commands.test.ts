import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRepositoryCommands } from "./repository-commands.js";

test("build-only setup is deferred without dropping existing checks", () => {
  assert.deepEqual(
    resolveRepositoryCommands({ setupCommand: " turbo run build ", testCommand: "pnpm test" }),
    {
      setupCommand: null,
      testCommand: "turbo run build && pnpm test",
      deferredSetup: true,
    },
  );
  assert.equal(
    resolveRepositoryCommands({ setupCommand: "npm run build", testCommand: "npm run build" }).testCommand,
    "npm run build",
  );
});
test("dependency setup and arbitrary shell commands keep their explicit meaning", () => {
  for (const command of [
    "pnpm install --frozen-lockfile",
    "npm ci && npm run build",
    "echo 'turbo run build'",
    "./setup.sh",
    "npm run build > build.log",
  ]) {
    assert.equal(resolveRepositoryCommands({ setupCommand: command }).setupCommand, command);
  }
  assert.equal(resolveRepositoryCommands({}).setupCommand, null);
});
