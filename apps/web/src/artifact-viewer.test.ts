import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactHeadActions, ZoomPane } from "./components/ArtifactViewer.js";

/** Every tag stripped: what is left is what a sighted user would read. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

test("ZoomPane is labelled and starts at 100%", () => {
  const html = renderToStaticMarkup(
    createElement(ZoomPane, { label: "image", children: createElement("img", { alt: "mockup", src: "about:blank" }) }),
  );
  assert.match(html, /aria-label="Zoom the image"/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /aria-label="Zoom out"/);
  assert.match(html, /aria-label="Reset zoom"/);
  assert.match(html, />100%</);
});

test("artifact header has expand and a new-tab link to the artifact page", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const html = renderToStaticMarkup(
    createElement(ArtifactHeadActions, { artifactId: id, expanded: false, onToggleExpand() {} }),
  );
  assert.match(html, /aria-label="Expand the viewer"/);
  assert.match(html, /aria-label="Open in a new tab"/);
  assert.match(html, new RegExp(`href="/artifact/${id}"`));
  assert.match(html, /target="_blank"/);
  assert.equal(visibleText(html), "");
});

test("expanded header offers shrink instead of expand", () => {
  const html = renderToStaticMarkup(
    createElement(ArtifactHeadActions, {
      artifactId: "11111111-1111-1111-1111-111111111111",
      expanded: true,
      onToggleExpand() {},
    }),
  );
  assert.match(html, /aria-label="Shrink the viewer"/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /aria-label="Expand the viewer"/);
});
