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
  assert.match(takeoverTitle("muse", true, "Muse Code"), /resume of the same session/);
  assert.match(takeoverTitle("fx", true, "fx"), /resume of the same session/);
});

test("a quiet tool says it prints one message when the run ends", () => {
  assert.equal(
    quietRunStatus("dsh", true),
    "DeepSeek Harness does not output messages while it is processing the prompt. DeepSeek Harness prints one final message when the run ends.",
  );
  assert.equal(quietRunStatus("dsh", false), null);
  assert.equal(quietRunStatus("codex", true), null);
  assert.equal(quietRunStatus("pool", true), null);
  assert.equal(quietRunStatus("muse", true), null);
  assert.equal(
    quietRunStatus("fx", true),
    "fx does not output messages while it is processing the prompt. fx prints one final message when the run ends.",
  );
});
