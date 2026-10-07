import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STAGES } from "@bento/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_SKELETON_STAGES,
  importBoardPipeline,
  loadBoardPipeline,
  rememberedStageCount,
  rememberStageCount,
} from "./board-shape.js";
import { BoardSkeleton } from "./components/Skeleton.js";

function browser() {
  const values = new Map<string, string>();
  const localStorage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } as Storage;
  return { localStorage, values };
}

test("a project this browser has not loaded gets the seeded pipeline's length", () => {
  const b = browser();
  assert.equal(rememberedStageCount("project-a", b), DEFAULT_STAGES.length);
  assert.equal(rememberedStageCount(null, b), DEFAULT_STAGES.length, "no project selected yet");
  assert.equal(rememberedStageCount("project-a", null), DEFAULT_STAGES.length, "no window at all");
});

test("each project keeps the count its board last loaded with", () => {
  const b = browser();
  rememberStageCount("six-stage", 6, b);
  rememberStageCount("empty", 0, b);
  assert.equal(rememberedStageCount("six-stage", b), 6);
  assert.equal(rememberedStageCount("empty", b), 0, "a pipeline with no stages is a real answer");
  assert.equal(rememberedStageCount("other", b), DEFAULT_STAGES.length);
  rememberStageCount("six-stage", 4, b);
  assert.equal(rememberedStageCount("six-stage", b), 4, "a later load replaces the count");
});

test("a value this app did not write is ignored", () => {
  const b = browser();
  for (const junk of ["", "three", "2.5", "-1", "9999", String(MAX_SKELETON_STAGES + 1)]) {
    b.values.set("bento:board-stages:p", junk);
    assert.equal(rememberedStageCount("p", b), DEFAULT_STAGES.length, `stored ${JSON.stringify(junk)}`);
  }
  rememberStageCount("q", -3, b);
  rememberStageCount("q", Number.NaN, b);
  rememberStageCount("q", 2.5, b);
  assert.equal(b.values.has("bento:board-stages:q"), false, "nonsense is never written");
});

/**
 * A longer pipeline used to be skipped, which left the last count
 * standing: a project that grew past the limit kept drawing its old
 * width. It is capped instead, so the stored count always moves.
 */
test("a pipeline longer than the cap is stored as the cap, not skipped", () => {
  const b = browser();
  rememberStageCount("long", 3, b);
  rememberStageCount("long", MAX_SKELETON_STAGES + 51, b);
  assert.equal(rememberedStageCount("long", b), MAX_SKELETON_STAGES);
  rememberStageCount("long", 51, b);
  assert.equal(rememberedStageCount("long", b), 51, "and an ordinary count past the old limit of 50 is kept");
});

test("storage that throws reads as unknown and writes nothing", () => {
  const throwing = {
    get localStorage(): Storage { throw new Error("SecurityError"); },
  };
  assert.equal(rememberedStageCount("p", throwing), DEFAULT_STAGES.length);
  assert.doesNotThrow(() => rememberStageCount("p", 4, throwing));
});

test("the skeleton draws backlog, one lane per stage, and done", async () => {
  const { skeletonLanes } = await import("./components/Skeleton.js");
  assert.equal(skeletonLanes(3).length, 5);
  assert.equal(skeletonLanes(6).length, 8, "a six stage project loads as eight lanes");
  assert.equal(skeletonLanes(0).length, 2, "no stages still frames the board");
  assert.equal(skeletonLanes(12).length, 14, "more stages than bone shapes still draws every lane");
  assert.equal(skeletonLanes(Number.NaN).length, DEFAULT_STAGES.length + 2);
});

test("loading a board's pipeline remembers its stage count, and a failed load remembers nothing", async () => {
  const b = browser();
  const pipeline = { id: "pipe", stages: [{}, {}, {}, {}, {}, {}] };
  const loaded = await loadBoardPipeline({ getPipeline: async (id: string) => (assert.equal(id, "six"), pipeline) }, "six", b);
  assert.equal(loaded, pipeline, "the pipeline comes back untouched");
  assert.equal(rememberedStageCount("six", b), 6);

  await assert.rejects(
    loadBoardPipeline({ getPipeline: async () => { throw new Error("offline"); } }, "down", b),
    /offline/,
  );
  assert.equal(b.values.has("bento:board-stages:down"), false);
});

/**
 * The Settings page imports a pipeline without refreshing a board, so
 * the import itself has to leave the new count behind.
 */
test("importing a pipeline file remembers the imported stage count", async () => {
  const b = browser();
  rememberStageCount("p", 3, b);
  const result = { stages: 6, agents: 2, removedStages: [], skippedRepositories: [] };
  const returned = await importBoardPipeline(
    { importPipeline: async (id: string, yaml: string) => (assert.equal(id, "p"), assert.equal(yaml, "version: 1"), result) },
    "p",
    "version: 1",
    b,
  );
  assert.equal(returned, result);
  assert.equal(rememberedStageCount("p", b), 6);

  await assert.rejects(
    importBoardPipeline({ importPipeline: async () => { throw new Error("bad file"); } }, "p", "nope", b),
    /bad file/,
  );
  assert.equal(rememberedStageCount("p", b), 6, "a refused import leaves the count alone");
});

test("the board skeleton draws the stored count for its project", () => {
  const b = browser();
  rememberStageCount("six", 6, b);
  const lanes = (projectId: string | null) =>
    renderToStaticMarkup(createElement(BoardSkeleton, { projectId, browser: b })).match(/<section class="lane"/g)?.length ?? 0;
  assert.equal(lanes("six"), 8, "backlog, six stages, done");
  assert.equal(lanes("unseen"), DEFAULT_STAGES.length + 2);
  assert.equal(lanes(null), DEFAULT_STAGES.length + 2);
});
