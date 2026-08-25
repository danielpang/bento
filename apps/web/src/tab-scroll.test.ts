import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPageSkeleton } from "./components/Skeleton.js";
import { TabScroll } from "./components/TabScroll.js";

test("TabScroll wraps a tab row with overflow cues at both ends", () => {
  const html = renderToStaticMarkup(
    createElement(TabScroll, {
      active: "appearance",
      children: createElement("div", { className: "tab-row" }, "Appearance"),
    }),
  );
  assert.match(html, /class="tab-scroll"/);
  assert.match(html, /tab-scroll-cue-start/);
  assert.match(html, /tab-scroll-cue-end/);
  assert.match(html, /class="tab-row"/);
});

test("the settings skeleton uses the same overflow wrapper as the live tabs", () => {
  const html = renderToStaticMarkup(createElement(SettingsPageSkeleton));
  assert.match(html, /class="tab-scroll"/);
  assert.match(html, /tab-scroll-cue-end/);
});
