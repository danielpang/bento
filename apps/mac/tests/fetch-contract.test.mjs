import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A POST with no body aborts the process.
 *
 * The SDK's HTTP client is Zig's `std.http.Client`, which asserts
 * `!method.requestHasBody()` before taking its bodiless path, and
 * POST, PUT and PATCH all have bodies by that definition. So a write
 * that needs no arguments (approve, reject, recheck, cancel, sign out)
 * still has to send something, or the whole app dies the moment
 * someone presses that button.
 *
 * Neither `native check` nor `native test` sees this: the spec is a
 * well-typed object either way, and the assert only fires in a live
 * process against a live server. It cost a crash on every card action
 * before anyone noticed, so it is checked here instead.
 */
const core = readFileSync(fileURLToPath(new URL("../src/core.ts", import.meta.url)), "utf8");

test("every POST, PUT and PATCH carries a body", () => {
  const bodyless = [];
  // Each Cmd.fetch spec is a brace-delimited object one level deep at
  // most, which is all the nesting `headers` adds.
  for (const match of core.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
    const spec = match[0];
    if (!spec.includes("url:")) continue;
    if (!/method: "(POST|PUT|PATCH)"/.test(spec)) continue;
    if (spec.includes("body:")) continue;
    const line = core.slice(0, match.index).split("\n").length;
    bodyless.push(`src/core.ts:${line} ${/url: ([^,\n]+)/.exec(spec)?.[1] ?? spec.slice(0, 60)}`);
  }
  assert.deepEqual(bodyless, [], `these would abort the app when pressed:\n${bodyless.join("\n")}`);
});

test("the request that proved it sends one", () => {
  // Reject was the button that found this, so it is the one named.
  const reject = /\{[^{}]*\/reject[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/.exec(core);
  assert.ok(reject, "the reject request is gone; this test needs a new subject");
  assert.match(reject[0], /body:/);
});
