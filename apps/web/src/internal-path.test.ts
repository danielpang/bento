import assert from "node:assert/strict";
import test from "node:test";
import { internalPath } from "./internal-path.js";

const HERE = "https://app.usebento.ai";

test("a path inside the app is kept whole", () => {
  assert.equal(internalPath("/accept-invitation?id=abc123", HERE), "/accept-invitation?id=abc123");
  assert.equal(internalPath("/sessions", HERE), "/sessions");
  assert.equal(internalPath("/session/x#run-2", HERE), "/session/x#run-2");
});

/**
 * The escapes a prefix check misses. Browsers fold a backslash into a
 * slash for http and https, so `/\evil.com` is another origin however
 * much it looks like a path; the tab and newline forms are stripped
 * before resolution and land in the same place. Each of these was
 * accepted by the `startsWith("/") && !startsWith("//")` guard this
 * function replaced.
 */
test("anything that resolves off this origin falls back to the board", () => {
  for (const raw of [
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "http://evil.com/path",
    "//evil.com/\\@app.usebento.ai",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert.equal(internalPath(raw, HERE), "/", `expected ${JSON.stringify(raw)} to be refused`);
  }
});

test("a lookalike host is not this origin", () => {
  assert.equal(internalPath("https://app.usebento.ai.evil.com/x", HERE), "/");
  assert.equal(internalPath("https://notapp.usebento.ai/x", HERE), "/");
});

test("an absolute address on this very origin is reduced to its path", () => {
  assert.equal(internalPath(`${HERE}/sessions?q=1`, HERE), "/sessions?q=1");
});

test("nothing to return to is the board", () => {
  assert.equal(internalPath(null, HERE), "/");
  assert.equal(internalPath(undefined, HERE), "/");
  assert.equal(internalPath("", HERE), "/");
});
