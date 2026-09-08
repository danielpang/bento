import { test } from "node:test";
import assert from "node:assert/strict";
import type { features, stages } from "@bento/db";
import { buildConflictResolutionPrompt, buildStagePrompt } from "./prompt.js";

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

/**
 * The fetch step is a literal command the agent runs. Two repositories
 * with different base branches must produce valid refspecs, not prose:
 * "git fetch origin main and develop" fails on the word "and".
 */
test("the conflict prompt names every base branch as a refspec", () => {
  const prompt = buildConflictResolutionPrompt("feature/x", [
    { name: "acme/web", number: 7, defaultBranch: "main" },
    { name: "acme/api", number: 9, defaultBranch: "develop" },
  ]);
  assert.match(prompt, /git fetch origin main develop/);
  assert.doesNotMatch(prompt, /main and develop/);
  assert.match(prompt, /#7/);
  assert.match(prompt, /#9/);
});

test("the conflict prompt forbids pushing and repeats no base branch", () => {
  const prompt = buildConflictResolutionPrompt("feature/x", [
    { name: "acme/web", number: 7, defaultBranch: "main" },
    { name: "acme/api", number: 9, defaultBranch: "main" },
  ]);
  assert.match(prompt, /git fetch origin main\./);
  assert.match(prompt, /Do not push/);
  assert.match(prompt, /rebase/);
});

/**
 * The efficiency gate. Code cannot judge whether a task deserves
 * splitting, so the prompt is where the judgement is asked for, and
 * the paragraph has to state both conditions rather than reading as an
 * invitation to decompose everything.
 */
test("an agent with the card tools is told when not to split", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [], undefined, undefined, true);
  assert.match(prompt, /create_card/);
  assert.match(prompt, /Only split when both are true/);
  assert.match(prompt, /edit the same files/);
  assert.match(prompt, /Most cards are one change/);
});

test("an agent without the tool is never told about splitting", () => {
  // Telling an agent to create cards when it has no tool to do it with
  // produces a run that writes the parts into prose and calls it done.
  const prompt = buildStagePrompt(feature, stage, [stage]);
  assert.doesNotMatch(prompt, /create_card/);
  assert.doesNotMatch(prompt, /split/i);
});

test("the merge prohibition still comes last, after the split paragraph", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [], undefined, undefined, true);
  assert.ok(prompt.indexOf("create_card") < prompt.indexOf("Stay on your branch"));
  assert.ok(prompt.trimEnd().endsWith("once this run finishes."));
});
