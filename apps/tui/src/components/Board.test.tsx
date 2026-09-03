import assert from "node:assert/strict";
import test from "node:test";
import type { Feature, Stage } from "@bento/api-client";
import { cardState, isFinished, orderFeatures } from "./Board.js";

function card(id: string, status: Feature["status"], stageId: string | null = null): Feature {
  return {
    id,
    projectId: "p",
    title: id,
    description: "",
    status,
    currentStageId: stageId,
    branchName: null,
    prNumber: null,
  };
}

function stage(id: string, name: string): Stage {
  return {
    id,
    pipelineId: "pipe",
    name,
    slug: name.toLowerCase(),
    position: 0,
    description: "",
    defaultAgentProfileId: null,
    gateType: "manual",
    gateCriteria: [],
    createPr: false,
  };
}

test("finished cards leave their stage and sit after the live ones", () => {
  const stages = [stage("impl", "Implementation"), stage("review", "Review")];
  const features = [
    card("backlog", "backlog"),
    card("live", "active", "review"),
    card("shipped", "done", "review"),
    card("abandoned", "cancelled", "impl"),
  ];
  const ordered = orderFeatures(stages, features).map((f) => f.id);
  assert.deepEqual(ordered, ["backlog", "live", "shipped", "abandoned"]);
});

test("a done card is finished even though it still names its last stage", () => {
  assert.equal(isFinished(card("shipped", "done", "review")), true);
  assert.equal(isFinished(card("live", "active", "review")), false);
  assert.equal(isFinished(card("held", "gated", "review")), false);
});

test("a working agent outranks the gate, and a finished card says completed", () => {
  assert.equal(cardState(card("held", "gated", "review"), "running"), "running");
  assert.equal(cardState(card("shipped", "done", "review"), "succeeded"), "completed");
});
