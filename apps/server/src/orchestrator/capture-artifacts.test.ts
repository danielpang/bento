import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactStorageKey, classifyArtifact } from "./capture-artifacts.js";

test("artifacts are classified by extension, and only into safe viewers", () => {
  assert.deepEqual(classifyArtifact("docs/bento/design.md"), {
    kind: "markdown",
    mime: "text/markdown",
    text: true,
  });
  assert.deepEqual(classifyArtifact("artifacts/flow.mmd"), { kind: "mermaid", mime: "text/plain", text: true });
  assert.deepEqual(classifyArtifact("artifacts/preview.HTML").kind, "html");
  assert.deepEqual(classifyArtifact("artifacts/shot.png"), { kind: "image", mime: "image/png", text: false });
  assert.equal(classifyArtifact("artifacts/notes.txt").kind, "file");

  // SVG can carry script, so it must never classify as an image the
  // console would render inline.
  assert.deepEqual(classifyArtifact("artifacts/logo.svg"), {
    kind: "file",
    mime: "application/octet-stream",
    text: false,
  });

  assert.equal(classifyArtifact("artifacts/blob").kind, "file");
  assert.equal(classifyArtifact("artifacts/archive.tar.gz").kind, "file");
});

test("storage keys are org-prefixed and never contain agent-chosen names", () => {
  const key = artifactStorageKey("org-a", { featureId: "feat-1" }, "run-1", "art-1");
  assert.equal(key, "org/org-a/feature/feat-1/run/run-1/art-1");
  assert.equal(artifactStorageKey(null, { featureId: "f" }, "r", "a"), "org/local/feature/f/run/r/a");
  // A swarm's artifacts are keyed by the swarm, so the two boards do
  // not share a prefix and nothing has to guess which one a key names.
  assert.equal(
    artifactStorageKey("org-a", { swarmId: "sw-1" }, "run-1", "art-1"),
    "org/org-a/swarm/sw-1/run/run-1/art-1",
  );
});
