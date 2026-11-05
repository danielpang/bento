import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectArtifactCard } from "@bento/api-client";
import { filterArtifactFiles, findMatch, searchArtifactCards } from "./artifacts-search.js";

function card(title: string, paths: string[]): ProjectArtifactCard {
  return {
    featureId: title,
    title,
    artifactCount: paths.length,
    kinds: ["markdown"],
    latestCreatedAt: "2026-01-01T00:00:00.000Z",
    paths,
    preview: { artifactId: "a", kind: "markdown" },
  };
}

test("findMatch splits around the first case insensitive hit", () => {
  assert.deepEqual(findMatch("Onboarding Design refresh", "design"), {
    before: "Onboarding ",
    hit: "Design",
    after: " refresh",
  });
  assert.equal(findMatch("Billing", "design"), null);
  assert.equal(findMatch("Billing", ""), null);
});

test("cards match on their title or a file name, never on a directory", () => {
  const cards = [
    card("Onboarding design refresh", ["docs/bento/plan.md"]),
    card("Create a tab", ["docs/bento/design.md", "docs/bento/code-review.md", "artifacts/design.md"]),
    card("Billing polish", ["docs/bento/notes.md"]),
  ];
  const results = searchArtifactCards(cards, "  DESIGN ");
  assert.deepEqual(
    results.map((row) => [row.card.title, row.files]),
    [
      ["Onboarding design refresh", []],
      ["Create a tab", ["design.md"]],
    ],
  );
  assert.equal(searchArtifactCards(cards, "bento").length, 0, "the path's folders are not searched");
  assert.equal(searchArtifactCards(cards, "").length, 3);
});

test("the file filter keeps names that contain the query", () => {
  const files = [{ path: "docs/quality-engineering.md" }, { path: "docs/design.md" }, { path: "engineering/x.md" }];
  assert.deepEqual(filterArtifactFiles(files, "Eng").map((f) => f.path), ["docs/quality-engineering.md"]);
  assert.equal(filterArtifactFiles(files, " ").length, 3);
});
