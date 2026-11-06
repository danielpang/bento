import { test } from "node:test";
import assert from "node:assert/strict";
import type { features, stages } from "@bento/db";
import { buildConflictResolutionPrompt, buildSessionPrompt, buildStagePrompt } from "./prompt.js";
import { SESSION_TITLE_MAX, isSessionCard, sessionTitle } from "./session-card.js";

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

test("an agent with the card tools is asked to set the pull request text", () => {
  const publishing = buildStagePrompt(feature, { ...stage, createPr: true }, [stage], [], undefined, undefined, true);
  assert.match(publishing, /set_pull_request/);
  assert.match(publishing, /add_pull_request_comment/);
  assert.match(publishing, /Bento applies it when this run publishes/);
  // The write-up is still asked for: the tools add to it, not replace it.
  assert.match(publishing, /write a concise summary of your work/);

  const notPublishing = buildStagePrompt(feature, { ...stage, createPr: false }, [stage], [], undefined, undefined, true);
  assert.match(notPublishing, /set_pull_request/);
  assert.match(notPublishing, /keeps them until the branch is published/);
});

test("an agent without the tools is never asked to set the pull request text", () => {
  // Naming a tool that is not there produces a write-up with a title
  // nobody copies anywhere, which is the mistake the removed slug
  // convention made in the other direction.
  const prompt = buildStagePrompt(feature, { ...stage, createPr: true }, [stage]);
  assert.doesNotMatch(prompt, /set_pull_request/);
  assert.doesNotMatch(prompt, /add_pull_request_comment/);
});

test("the merge prohibition still comes last, after the split paragraph", () => {
  const prompt = buildStagePrompt(feature, stage, [stage], [], undefined, undefined, true);
  assert.ok(prompt.indexOf("create_card") < prompt.indexOf("Stay on your branch"));
  assert.ok(prompt.trimEnd().endsWith("once this run finishes."));
});


test("stage prompts describe server-owned publication and the actual automatic PR setting", () => {
  for (const createPr of [true, false]) {
    const prompt = buildStagePrompt(feature, { ...stage, createPr }, [stage]);
    assert.match(prompt, /do not run git push or gh pr create/);
    assert.match(prompt, /do not ask the user for GitHub tokens/);
    assert.match(prompt, createPr ? /Automatic PR creation is enabled/ : /Automatic PR creation is off/);
  }
});

/**
 * A session from the Sessions tab has no stage, so its agent must not be
 * told about one: no stage goal, no write-up file, and no promise of an
 * automatic pull request the executor will not open.
 */
test("a session's prompt names no stage and promises no automatic pull request", () => {
  const prompt = buildSessionPrompt(
    [{ name: "api", mountPath: "/workspace/api", testCommand: "pnpm test" }],
    { name: "Claude Code (claude-sonnet-5)", skill: null },
    "/workspace/artifacts",
  );
  assert.doesNotMatch(prompt, /stage/i);
  assert.doesNotMatch(prompt, /docs\/bento/);
  assert.match(prompt, /Nothing is published automatically/);
  assert.match(prompt, /The repository is checked out at \/workspace\/api/);
  assert.match(prompt, /Check your work by running: pnpm test/);
  assert.match(prompt, /Never merge into main or master/);
  // The fake agent reads these words as instructions, and a session
  // prompt carrying one would fail or stall every run.
  assert.doesNotMatch(prompt, /FAIL|SLOW|ARTIFACT|LIVE|VERDICT/);
});

test("a session is titled by the first line of its message, cut at a word", () => {
  assert.equal(sessionTitle("  \n Why does login loop?\nMore detail here"), "Why does login loop?");
  const long = sessionTitle("word ".repeat(40));
  assert.ok(long.length <= SESSION_TITLE_MAX, long);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(long, /wor…$/);
});

test("only a session still in the backlog is treated as one", () => {
  assert.equal(isSessionCard({ standalone: true, currentStageId: null }), true);
  assert.equal(isSessionCard({ standalone: true, currentStageId: "stage" }), false);
  assert.equal(isSessionCard({ standalone: false, currentStageId: null }), false);
});
