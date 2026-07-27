import { test } from "node:test";
import assert from "node:assert/strict";
import type { features, stages } from "@bento/db";
import { buildStagePrompt } from "./prompt.js";

type Feature = typeof features.$inferSelect;
type Stage = typeof stages.$inferSelect;

const feature = { title: "Add search", description: "Users cannot find anything" } as Feature;
const stage = { name: "Build", slug: "build", description: "Write the code", position: 0 } as Stage;

/**
 * A repository's test command exists so the agent can check itself
 * while it can still fix what it broke. That only works if the prompt
 * actually carries it.
 */
test("the prompt tells the agent how to check its work", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [
    { name: "api", mountPath: "/workspace/api", testCommand: "pnpm test" },
  ]);
  assert.match(prompt, /Check your work by running: pnpm test/);
  assert.match(prompt, /must pass before you finish/);
});

test("each repository's own check is named with its path", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [
    { name: "api", mountPath: "/workspace/api", testCommand: "go test ./..." },
    { name: "web", mountPath: "/workspace/web", testCommand: "npm test" },
  ]);
  assert.match(prompt, /- in \/workspace\/api: go test \.\/\.\.\./);
  assert.match(prompt, /- in \/workspace\/web: npm test/);
});

/**
 * A repository with no test command says nothing rather than inventing
 * one: an agent told to "run the tests" in a project that has none
 * spends the stage looking for them.
 */
test("a repository without a check adds nothing to the prompt", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [
    { name: "api", mountPath: "/workspace/api", testCommand: null },
  ]);
  assert.doesNotMatch(prompt, /Check your work/);
});

test("a repository whose check is only whitespace is treated as having none", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [
    { name: "api", mountPath: "/workspace/api", testCommand: "   " },
  ]);
  assert.doesNotMatch(prompt, /Check your work/);
});
