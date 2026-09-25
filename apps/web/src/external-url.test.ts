import assert from "node:assert/strict";
import test from "node:test";
import { externalHttpUrl } from "./external-url.js";

/**
 * The scheme check that stands between a row an agent influenced and
 * an `href` on the console's origin.
 *
 * The cases that matter are not the obvious ones. `javascript:` in
 * lower case is what a person writes in a bug report; what actually
 * reaches a real page is the same scheme with a tab in it, or in mixed
 * case, or wearing a `data:` label, because every one of those is
 * folded away by the parser before the browser decides what to do and
 * by none of the string comparisons somebody writes instead.
 */

test("an ordinary pull request address is linkable", () => {
  assert.equal(
    externalHttpUrl("https://github.com/acme/app/pull/12"),
    "https://github.com/acme/app/pull/12",
  );
  assert.equal(externalHttpUrl("http://localhost:4400/x"), "http://localhost:4400/x");
});

test("a javascript url is refused, however it is spelled", () => {
  for (const raw of [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0000javascript:alert(1)",
  ]) {
    assert.equal(externalHttpUrl(raw), null, `${JSON.stringify(raw)} must not become an href`);
  }
});

test("the other schemes that execute or embed are refused too", () => {
  assert.equal(externalHttpUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(externalHttpUrl("vbscript:msgbox(1)"), null);
  assert.equal(externalHttpUrl("blob:https://example.test/abc"), null);
  assert.equal(externalHttpUrl("file:///etc/passwd"), null);
});

test("anything that is not an absolute address is refused rather than resolved", () => {
  assert.equal(externalHttpUrl("/settings"), null, "a path would resolve against whatever page is open");
  assert.equal(externalHttpUrl("//evil.test/x"), null);
  assert.equal(externalHttpUrl("not a url"), null);
  assert.equal(externalHttpUrl(""), null);
  assert.equal(externalHttpUrl(null), null);
  assert.equal(externalHttpUrl(undefined), null);
});

test("what comes back is what was checked, not the string that was handed in", () => {
  // The parser folds a backslash into a slash for http, so the raw
  // string and what the browser would do with it differ. Returning the
  // parsed form is what keeps the two the same.
  assert.equal(externalHttpUrl("https://github.com\\acme"), "https://github.com/acme");
});
