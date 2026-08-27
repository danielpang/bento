import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG_URL } from "./changelog.js";
import { BottomBar } from "./components/BottomBar.js";

test("Changelog opens the marketing site in a new tab", () => {
  const html = renderToStaticMarkup(createElement(BottomBar, { onContact() {} }));
  assert.match(html, new RegExp(`href="${CHANGELOG_URL}"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
  assert.doesNotMatch(html, /href="\/changelog"/);
});
