import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LinearIssueOption } from "@bento/api-client";

/**
 * The panel reaches the auth client through the dialogs it imports, and
 * that reads an origin off window as it loads. Enough window to get the
 * module graph in, then the import: a browser global is not what this
 * row is being asked about.
 */
(globalThis as { window?: unknown }).window = { location: { origin: "http://localhost" } };
const { ImportIssueRow } = await import("./components/LinearPanel.js");

function issue(overrides: Partial<LinearIssueOption> = {}): LinearIssueOption {
  return {
    id: "iss_1",
    identifier: "DPA-6",
    title: "Indicate issues are already in Bento",
    url: "https://linear.app/x/issue/DPA-6",
    stateName: "Backlog",
    imported: false,
    ...overrides,
  };
}

function row(issueOption: LinearIssueOption, busy = false): string {
  return renderToStaticMarkup(
    createElement(ImportIssueRow, { issue: issueOption, checked: false, busy, onToggle() {} }),
  );
}

/** Every tag stripped: what is left is what a sighted user would read. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

test("an already linked issue states it is in Bento, on the row and on hover", () => {
  const html = row(issue({ imported: true }));
  assert.match(visibleText(html), /Already in Bento/);
  assert.match(html, /title="This issue is already a card in Bento, so it cannot be imported again."/);
  assert.match(html, /disabled=""/);
});

test("the cue is part of the checkbox's name, not a chip beside the label", () => {
  const html = row(issue({ imported: true }));
  const label = html.slice(html.indexOf("<label"), html.indexOf("</label>"));
  assert.match(label, /Already in Bento/);
});

test("an already linked issue no longer reads as jargon", () => {
  assert.doesNotMatch(visibleText(row(issue({ imported: true }))), /\(imported\)/);
});

test("an issue Bento does not have is selectable and carries no cue", () => {
  const html = row(issue());
  assert.doesNotMatch(html, /disabled/);
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(html, /chip/);
  assert.doesNotMatch(visibleText(html), /Already in Bento/);
});

test("an import in flight disables a fresh row without claiming Bento has it", () => {
  const html = row(issue(), true);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(visibleText(html), /Already in Bento/);
});
