import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG_URL } from "./changelog.js";
import { Sidebar } from "./components/Sidebar.js";

function render(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      places: [
        { id: "needs-you", label: "Needs you", href: "/?board=pipeline", count: 3, signal: true, onSelect() {} },
        { id: "board", label: "Board", href: "/?board=pipeline", current: true, onSelect() {} },
        { id: "swarms", label: "Swarms", href: "/?board=swarms", locked: true },
        { id: "artifacts", label: "Artifacts", href: "/artifacts" },
      ],
      configure: [{ id: "agents", label: "Agents", onSelect() {} }],
      footer: [
        { id: "contact", label: "Contact", onSelect() {} },
        { id: "changelog", label: "Changelog", href: CHANGELOG_URL, external: true },
        { id: "settings", label: "Settings", href: "/settings" },
      ],
      ...overrides,
    }),
  );
}

test("the sidebar's places are links, and only the open one is current", () => {
  const html = render();
  assert.match(html, /<nav[^>]*aria-label="Workspace"/);
  assert.equal(html.match(/aria-current="page"/g)?.length, 1);
  assert.match(html, /href="\/\?board=pipeline" aria-current="page"[^>]*><span class="sidebar-item-label">Board/);
  assert.match(html, /href="\/artifacts"/);
});

test("Needs you carries its count in the signal badge, and a zero count draws nothing", () => {
  assert.match(render(), /Needs you<\/span><span class="count count-signal">3<\/span>/);
  const none = render({ places: [{ id: "needs-you", label: "Needs you", href: "/", count: 0, signal: true }] });
  assert.doesNotMatch(none, /count-signal/);
});

test("the foot is its own landmark, and the changelog opens in a new tab", () => {
  const html = render();
  assert.match(html, /<nav class="sidebar-foot" aria-label="About Bento">/);
  assert.match(html, new RegExp(`href="${CHANGELOG_URL}" target="_blank" rel="noreferrer"`));
});

test("the command palette key shows only where there is a palette", () => {
  assert.doesNotMatch(render(), /Find a card or action/);
  assert.match(render({ onCommands() {} }), /aria-label="Find a card or action"/);
});
