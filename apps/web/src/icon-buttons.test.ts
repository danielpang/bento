import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutButton, StopButton } from "./components/IconButtons.js";

/** Every tag stripped: what is left is what a sighted user would read. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

test("StopButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(StopButton, { disabled: false, onClick() {} }));
  assert.match(html, /aria-label="Stop the agent"/);
  assert.match(html, /title="Stop the agent"/);
  assert.match(html, /stop-square/);
  assert.equal(visibleText(html), "");
});

test("StopButton renders disabled while the cancellation is in flight", () => {
  const html = renderToStaticMarkup(createElement(StopButton, { disabled: true, onClick() {} }));
  assert.match(html, /disabled=""/);
});

test("SignOutButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(SignOutButton, { onClick() {} }));
  assert.match(html, /aria-label="Sign out"/);
  assert.match(html, /title="Sign out"/);
  assert.match(html, /signout-mark/);
  assert.equal(visibleText(html), "");
});
