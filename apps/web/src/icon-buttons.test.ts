import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutButton, StopButton } from "./components/IconButtons.js";

test("StopButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(StopButton, { disabled: false, onClick() {} }));
  assert.match(html, /aria-label="Stop the agent"/);
  assert.match(html, /title="Stop the agent"/);
  assert.match(html, /stop-square/);
  assert.doesNotMatch(html, />Stop</);
});

test("SignOutButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(SignOutButton, { onClick() {} }));
  assert.match(html, /aria-label="Sign out"/);
  assert.match(html, /title="Sign out"/);
  assert.match(html, /signout-mark/);
  assert.doesNotMatch(html, />Sign out</);
});
