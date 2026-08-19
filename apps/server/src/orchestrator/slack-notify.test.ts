import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseSlackProject,
  projectPickFromInteractive,
  projectPickerBlocks,
  projectPickValue,
  reviewBlocks,
} from "./slack-notify.js";

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

test("projectPickerBlocks put the pending id on each button value", () => {
  const pendingId = "11111111-1111-1111-1111-111111111111";
  const projectId = "22222222-2222-2222-2222-222222222222";
  const blocks = projectPickerBlocks(pendingId, [{ id: projectId, name: "Checkout" }]);
  const actions = blocks[1] as {
    block_id: string;
    elements: { action_id?: string; type?: string; value?: string }[];
  };
  assert.equal(actions.block_id, `pick_${pendingId}`);
  assert.equal(actions.elements[0]?.type, "button");
  assert.equal(actions.elements[0]?.action_id, "pick_project_0");
  assert.equal(actions.elements[0]?.value, projectPickValue(pendingId, projectId));
  assert.ok(actions.elements[0]!.value!.length <= 75);
});

test("chooseSlackProject uses a matching default, else the only option", () => {
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  assert.equal(chooseSlackProject(b, [{ id: a }, { id: b }]), b);
  assert.equal(chooseSlackProject(null, [{ id: a }]), a);
  assert.equal(chooseSlackProject(null, [{ id: a }, { id: b }]), null);
  assert.equal(chooseSlackProject("cccccccc-cccc-cccc-cccc-cccccccccccc", [{ id: a }, { id: b }]), null);
});

test("projectPickFromInteractive reads channel from the container and the pending id from the option", () => {
  const pendingId = "11111111-1111-1111-1111-111111111111";
  const projectId = "22222222-2222-2222-2222-222222222222";
  const pick = projectPickFromInteractive({
    user: { id: "U1", team_id: "T1" },
    team: undefined,
    container: { channel_id: "C1" },
    actions: [
      {
        action_id: "pick_project",
        block_id: "=rewritten",
        selected_option: { value: projectPickValue(pendingId, projectId) },
      },
    ],
  });
  assert.deepEqual(pick, {
    teamId: "T1",
    channelId: "C1",
    userId: "U1",
    pendingId,
    projectId,
  });
});

test("projectPickFromInteractive reads a button value without team or channel", () => {
  const pendingId = "11111111-1111-1111-1111-111111111111";
  const projectId = "22222222-2222-2222-2222-222222222222";
  const pick = projectPickFromInteractive({
    user: { id: "U1" },
    actions: [
      {
        action_id: `pick_project_0`,
        value: projectPickValue(pendingId, projectId),
      },
    ],
  });
  assert.deepEqual(pick, {
    teamId: "",
    channelId: "",
    userId: "U1",
    pendingId,
    projectId,
  });
});

test("projectPickFromInteractive still accepts a project id when Slack rewrote the block id", () => {
  const projectId = "22222222-2222-2222-2222-222222222222";
  const pick = projectPickFromInteractive({
    user: { id: "U1" },
    team: { id: "T1" },
    channel: { id: "C1" },
    actions: [
      {
        action_id: "pick_project",
        block_id: "=qXel",
        selected_option: { value: projectId },
      },
    ],
  });
  assert.deepEqual(pick, {
    teamId: "T1",
    channelId: "C1",
    userId: "U1",
    pendingId: "",
    projectId,
  });
});

test("projectPickFromInteractive does not treat Approve as a project pick", () => {
  const featureId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const stageId = "11111111-1111-1111-1111-111111111111";
  const pick = projectPickFromInteractive({
    user: { id: "U1", team_id: "T1" },
    channel: { id: "C1" },
    actions: [{ action_id: "approve", value: `${featureId}:${stageId}` }],
  });
  assert.equal(pick, null);
});
