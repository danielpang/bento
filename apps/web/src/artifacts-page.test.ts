import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactsGridSkeleton } from "./components/Skeleton.js";
import { artifactCountLabel, formatUpdatedAgo } from "./artifacts-format.js";

test("artifact count copy singularizes correctly", () => {
  assert.equal(artifactCountLabel(1), "1 artifact");
  assert.equal(artifactCountLabel(4), "4 artifacts");
});

test("formatUpdatedAgo prints relative minutes and hours", () => {
  const now = Date.parse("2025-06-01T14:00:00.000Z");
  assert.equal(formatUpdatedAgo("2025-06-01T13:30:00.000Z", now), "Updated 30m ago");
  assert.equal(formatUpdatedAgo("2025-06-01T12:00:00.000Z", now), "Updated 2h ago");
});

test("the loading grid exposes eight inert tiles", () => {
  const html = renderToStaticMarkup(createElement(ArtifactsGridSkeleton, { framed: true }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading artifacts/);
  assert.equal((html.match(/class="artifacts-tile"/g) ?? []).length, 8);
});
