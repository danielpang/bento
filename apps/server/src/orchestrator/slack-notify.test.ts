import assert from "node:assert/strict";
import { test } from "node:test";
import { projectPickerBlocks, reviewBlocks } from "./slack-notify.js";

test("reviewBlocks include Approve, Reject, and Open card", () => {
  const featureId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const stageId = "11111111-1111-1111-1111-111111111111";
  const blocks = reviewBlocks("*Design* needs review.", featureId, stageId, "https://bento.example/?feature=x");
  assert.equal(blocks[0]?.type, "section");
  const actions = blocks[1] as { elements: { action_id?: string; value?: string; url?: string }[] };
  assert.deepEqual(
    actions.elements.map((el) => el.action_id),
    ["approve", "reject", "open_card"],
  );
  assert.equal(actions.elements[0]?.value, `${featureId}:${stageId}`);
  assert.equal(actions.elements[2]?.url, "https://bento.example/?feature=x");
});

test("projectPickerBlocks put the pending id on the actions block", () => {
  const pendingId = "11111111-1111-1111-1111-111111111111";
  const blocks = projectPickerBlocks(pendingId, [
    { id: "22222222-2222-2222-2222-222222222222", name: "Checkout" },
  ]);
  const actions = blocks[1] as {
    block_id: string;
    elements: { action_id?: string; options?: { value: string }[] }[];
  };
  assert.equal(actions.block_id, pendingId);
  assert.equal(actions.elements[0]?.action_id, "pick_project");
  assert.equal(actions.elements[0]?.options?.[0]?.value, "22222222-2222-2222-2222-222222222222");
});
