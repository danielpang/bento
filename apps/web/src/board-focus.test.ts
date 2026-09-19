import assert from "node:assert/strict";
import test from "node:test";
import type { Feature } from "@bento/api-client";
import { attentionLabel, readBoardFocus, workGroup } from "./board-focus.js";

const card = (status: Feature["status"]) => ({ status } as Feature);

test("attention excludes finished cards and gates with an active agent", () => {
  for (const status of ["queued", "starting", "running"]) {
    assert.equal(workGroup(card("gated"), status), "running");
  }
  for (const status of ["done", "cancelled"] as const) {
    assert.equal(workGroup(card(status), "failed"), "completed");
  }
  assert.equal(workGroup(card("gated"), "succeeded"), "needs-you");
  assert.equal(workGroup(card("active"), "failed"), "needs-you");
  assert.equal(workGroup(card("active"), "cancelled"), "needs-you");
  assert.equal(workGroup(card("active")), "ready");
});

test("stale stored filters fall back to all cards", () => {
  assert.equal(readBoardFocus("needs-you"), "needs-you");
  assert.equal(readBoardFocus("running"), "running");
  assert.equal(readBoardFocus("old-filter"), "all");
  assert.equal(readBoardFocus(null), "all");
});

test("attention copy distinguishes a failed run from an approval and an automatic gate", () => {
  assert.equal(attentionLabel(card("gated"), "failed", true), "Run needs attention");
  assert.equal(attentionLabel(card("gated"), "succeeded", true), "Ready for your review");
  assert.equal(attentionLabel(card("gated"), "succeeded", false), "Requirements need attention");
  assert.equal(attentionLabel(card("gated"), "running", true), undefined);
  assert.equal(attentionLabel(card("done"), "failed", true), undefined);
});
