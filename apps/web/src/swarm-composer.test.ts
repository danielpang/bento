import assert from "node:assert/strict";
import test from "node:test";
import { attachmentName, attachmentSize, GOAL_SUGGESTIONS, goalSuggestion, nameFromGoal, suggestBranch, swarmNameFor, UNTITLED_SWARM } from "./swarm/new-swarm.js";
import { defaultsDiffer } from "./components/SwarmComposer.js";
import { DEFAULT_RUN_SETTINGS } from "./components/SwarmSettingsFields.js";
import { formatAge, formatDuration, shortDate } from "./swarm/time.js";
import { artifactSourceLabel, artifactTypeLabel, artifactsAfterRefetch, splitArtifactPath } from "./swarm/artifacts.js";
import { isApplePlatform, sendModifierName } from "./platform.js";
import { orderArtifacts, repoLabel } from "./components/SwarmPage.js";
import { seedSwarms } from "./swarm/fixtures.js";
import type { SwarmArtifact } from "./swarm/types.js";

/**
 * The pure words the redesigned swarm pages print: the name the
 * composer suggests, how old a row is, and how an artifact is named.
 */

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

test("a swarm is named from the first words of its goal", () => {
  assert.equal(nameFromGoal("Build an MVP for OpenBot according to the attached spec."), "Build an MVP for OpenBot");
  assert.equal(nameFromGoal("fix the flaky login test. Then the rest."), "Fix the flaky login test");
  // Never past the first sentence, and never ending on a small word.
  assert.equal(nameFromGoal("Port the queue to the new worker"), "Port the queue");
  assert.equal(nameFromGoal("Move billing onto the shared build"), "Move billing onto the shared");
  // The first line that says anything, without its heading or list mark.
  assert.equal(nameFromGoal("\n\n# Checkout rewrite\nReplace the card field."), "Checkout rewrite");
  assert.equal(nameFromGoal("- Retire v1: remove the endpoints"), "Retire v1");
  assert.equal(nameFromGoal("1. Ship the CLI"), "Ship the CLI");
  // A word that starts with a digit keeps it.
  assert.equal(nameFromGoal("2FA for the admin pages"), "2FA for the admin pages");
  assert.equal(nameFromGoal("Don't break the \"legacy\" exports"), "Don't break the legacy exports");
  assert.equal(nameFromGoal(""), "");
  assert.equal(nameFromGoal("   \n  "), "");
  // A name made of one enormous word is cut to what fits.
  assert.ok(nameFromGoal("x".repeat(300)).length <= 60);
  // The branch the server will name follows from it.
  assert.equal(suggestBranch(nameFromGoal("Build an MVP for OpenBot")), "bento/build-an-mvp-for-openbot");
});

test("an attachment's chip says its name and its size in bytes", () => {
  assert.equal(attachmentName({ kind: "file", name: "plan.md", content: "# Plan" }), "plan.md");
  assert.equal(attachmentName({ kind: "website", url: "https://docs.openbot.dev/spec/" }), "docs.openbot.dev/spec");
  assert.equal(attachmentSize({ kind: "file", name: "plan.md", content: "x".repeat(4096) }), "4 KB");
  assert.equal(attachmentSize({ kind: "file", name: "a.png", mime: "image/png", data: "AAAA" }), "3 bytes");
  assert.equal(attachmentSize({ kind: "website", url: "https://example.com" }), null);
});

test("the shortcut is named for the keyboard in front of the person", () => {
  assert.equal(isApplePlatform({ platform: "MacIntel" }), true);
  assert.equal(isApplePlatform({ platform: "iPhone" }), true);
  assert.equal(isApplePlatform({ platform: "Win32" }), false);
  assert.equal(isApplePlatform({ platform: "Linux x86_64" }), false);
  // The modern hint wins over the old one when a browser gives both.
  assert.equal(isApplePlatform({ platform: "", userAgentData: { platform: "macOS" } }), true);
  assert.equal(isApplePlatform({ platform: "MacIntel", userAgentData: { platform: "Windows" } }), false);
  assert.equal(isApplePlatform({}), false);
  assert.equal(sendModifierName(true), "Cmd");
  assert.equal(sendModifierName(false), "Ctrl");
});

test("a refetch that failed keeps the artifacts, and one that changed nothing keeps the same list", () => {
  const rows = [artifact({ id: "a" }), artifact({ id: "b", path: "docs/b.md" })];
  assert.equal(artifactsAfterRefetch(rows, null), rows, "a failed refetch is not an empty swarm");
  assert.equal(artifactsAfterRefetch(rows, rows.map((row) => ({ ...row }))), rows, "the same rows keep the same array");
  const grown = [...rows, artifact({ id: "c", path: "docs/c.md" })];
  assert.equal(artifactsAfterRefetch(rows, grown), grown);
  const rewritten = [rows[0]!, { ...rows[1]!, size: rows[1]!.size + 1 }];
  assert.equal(artifactsAfterRefetch(rows, rewritten), rewritten, "a rewritten file is a change");
  assert.deepEqual(artifactsAfterRefetch([], []), []);
});

test("an age is a few characters, and a date once it is old", () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  assert.equal(formatAge(ago(20_000), NOW), "just now");
  assert.equal(formatAge(ago(12 * 60_000), NOW), "12m ago");
  assert.equal(formatAge(ago(3 * 3_600_000), NOW), "3h ago");
  assert.equal(formatAge(ago(2 * 86_400_000), NOW), "2d ago");
  assert.equal(formatAge(ago(30 * 86_400_000), NOW), shortDate(ago(30 * 86_400_000), NOW));
  assert.equal(formatAge(new Date(NOW + 60_000).toISOString(), NOW), "just now", "a clock ahead is not a negative age");
  assert.equal(formatAge(null, NOW), "");
  assert.equal(formatAge("not a date", NOW), "");
  assert.equal(shortDate("2026-10-24T12:00:00.000Z", NOW), "Oct 24");
  assert.equal(shortDate("2025-10-24T12:00:00.000Z", NOW), "Oct 24, 2025");
});

test("a duration steps up into days", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(90 * 60_000), "1h 30m");
  assert.equal(formatDuration((2 * 24 + 6) * 3_600_000 + 5 * 60_000), "2d 6h");
});

function artifact(over: Partial<SwarmArtifact>): SwarmArtifact {
  return {
    id: "a",
    runId: "r",
    swarmTaskId: null,
    stageSlug: "worker",
    stageName: "Worker",
    path: "docs/bento/swarm/design.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 18_000,
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

test("an artifact is named by its type, its source and its file", () => {
  assert.deepEqual(
    (["markdown", "mermaid", "image", "html", "file"] as const).map(artifactTypeLabel),
    ["Markdown", "Diagram", "Image", "HTML", "File"],
  );
  const tasks = seedSwarms("p1", NOW).find((entry) => entry.swarm.id === "sw-checkout")!.tasks;
  const task = tasks[1]!;
  assert.equal(artifactSourceLabel(artifact({ swarmTaskId: task.id }), tasks), task.title, "the task that wrote it");
  assert.equal(artifactSourceLabel(artifact({ swarmTaskId: "gone", stageName: "Final check" }), tasks), "Final check", "a task no longer in the tree falls back to the stage");
  assert.equal(artifactSourceLabel(artifact({ stageName: "Document" }), tasks), "Document");
  assert.deepEqual(splitArtifactPath("docs/bento/swarm/design.md"), { name: "design.md", dir: "docs/bento/swarm/" });
  assert.deepEqual(splitArtifactPath("README.md"), { name: "README.md", dir: "" });
});

test("a document swarm lists its assembled file first, and the drawer steps in that order", () => {
  const worker = artifact({ id: "w", stageSlug: "worker" });
  const document = artifact({ id: "d", stageSlug: "document", stageName: "Document" });
  assert.deepEqual(orderArtifacts([worker, document], "document").map((row) => row.id), ["d", "w"]);
  assert.deepEqual(orderArtifacts([worker, document], "code").map((row) => row.id), ["w", "d"]);
});

test("a repository is named without its host", () => {
  assert.equal(repoLabel("github.com/acme/storefront"), "acme/storefront");
  assert.equal(repoLabel("https://github.com/acme/storefront.git"), "acme/storefront");
  assert.equal(repoLabel("https://gitlab.example.com/acme/app/"), "gitlab.example.com/acme/app");
});

test("the empty composer cycles through sample goals and wraps round", () => {
  assert.equal(goalSuggestion(0), "Rewrite the whole app in Rust");
  assert.equal(goalSuggestion(1), "Migrate the database to Postgres");
  assert.equal(goalSuggestion(GOAL_SUGGESTIONS.length), goalSuggestion(0));
  assert.equal(goalSuggestion(GOAL_SUGGESTIONS.length * 3 + 5), "Upgrade PHP to fix vulnerabilities");
});

test("a goal that opens with punctuation is still named from its words", () => {
  assert.equal(nameFromGoal(". Fix the build"), "Fix the build");
  assert.equal(nameFromGoal(": migrate the db"), "Migrate the db");
  assert.equal(nameFromGoal("\n...\nPort the queue to Rust"), "Port the queue to Rust");
  // A goal with no word in it is created as Untitled, so Create is never refused for the name.
  assert.equal(nameFromGoal("..."), "");
  assert.equal(swarmNameFor("..."), UNTITLED_SWARM);
  assert.equal(swarmNameFor(". Fix the build"), "Fix the build");
  assert.equal(swarmNameFor("   "), "");
});

test("the Defaults dot shows only when something behind Defaults was changed", () => {
  const base = { budget: "", timeLimit: "", deliverable: "code" as const, startBranch: "", runSettings: DEFAULT_RUN_SETTINGS };
  assert.equal(defaultsDiffer(base), false);
  assert.equal(defaultsDiffer({ ...base, budget: "40" }), true);
  assert.equal(defaultsDiffer({ ...base, timeLimit: "90" }), true);
  assert.equal(defaultsDiffer({ ...base, deliverable: "document" }), true);
  assert.equal(defaultsDiffer({ ...base, startBranch: "feature/checkout" }), true);
  assert.equal(defaultsDiffer({ ...base, runSettings: { ...DEFAULT_RUN_SETTINGS, completionCommand: "pnpm test" } }), true);
  assert.equal(defaultsDiffer({ ...base, runSettings: { ...DEFAULT_RUN_SETTINGS, maxPlanDepth: 2 } }), true);
  // Whitespace typed and cleared is not a change.
  assert.equal(defaultsDiffer({ ...base, budget: "  ", runSettings: { ...DEFAULT_RUN_SETTINGS, completionCommand: " " } }), false);
});
