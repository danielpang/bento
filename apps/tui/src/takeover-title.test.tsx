import assert from "node:assert/strict";
import test from "node:test";
import { takeoverTitle, quietRunStatus } from "./app.js";

test("tools without session ids do not promise a session they cannot resume", () => {
  for (const cli of ["pool", "dsh"]) {
    assert.match(takeoverTitle(cli, true, "Agent"), /as a new run/);
    assert.doesNotMatch(takeoverTitle(cli, true, "Agent"), /resume|same session/);
  }
});

test("other between-run tools still promise their resumable session", () => {
  assert.match(takeoverTitle("codex", true, "Codex"), /resume of the same session/);
});

test("a quiet tool names the stall as the tool, not a hang", () => {
  assert.match(quietRunStatus("dsh", true) ?? "", /No live output from this tool/);
  assert.match(quietRunStatus("dsh", true) ?? "", /not a stall/);
  assert.equal(quietRunStatus("dsh", false), null);
  assert.equal(quietRunStatus("codex", true), null);
  assert.equal(quietRunStatus("pool", true), null);
});
