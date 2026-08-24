import assert from "node:assert/strict";
import test from "node:test";
import { takeoverTitle } from "./app.js";

test("pool takeover copy does not promise a session it cannot resume", () => {
  assert.match(takeoverTitle("pool", true, "Pool agent"), /as a new run/);
  assert.doesNotMatch(takeoverTitle("pool", true, "Pool agent"), /resume|same session/);
});

test("other between-run tools still promise their resumable session", () => {
  assert.match(takeoverTitle("codex", true, "Codex"), /resume of the same session/);
});
