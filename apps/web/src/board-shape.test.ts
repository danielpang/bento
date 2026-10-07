import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STAGES } from "@bento/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_SKELETON_LANES,
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
  rememberStageCount("two-stage", 2, b);
  rememberStageCount("empty", 0, b);
  assert.equal(rememberedStageCount("two-stage", b), 2);
  assert.equal(rememberedStageCount("empty", b), 0, "a pipeline with no stages is a real answer");
  assert.equal(rememberedStageCount("other", b), DEFAULT_STAGES.length);
  rememberStageCount("two-stage", 1, b);
  assert.equal(rememberedStageCount("two-stage", b), 1, "a later load replaces the count");
});

test("a value this app did not write is ignored", () => {
  const b = browser();
  for (const junk of ["", "three", "2.5", "-1", "9999"]) {
    b.values.set("bento:board-stages:p", junk);
    assert.equal(rememberedStageCount("p", b), DEFAULT_STAGES.length, `stored ${JSON.stringify(junk)}`);
  }
  rememberStageCount("q", -3, b);
  rememberStageCount("q", Number.NaN, b);
  rememberStageCount("q", 2.5, b);
  assert.equal(b.values.has("bento:board-stages:q"), false, "nonsense is never written");
});

/**
 * A skeleton draws at most the default board's five columns. A
 * pipeline with more stages than fit loads as the default shape; only
 * a shorter one draws fewer. The real count is still stored, so a
 * pipeline that shrinks back is drawn at its own width again.
 */
test("a pipeline too long for five columns loads as the default shape", () => {
  assert.equal(MAX_SKELETON_LANES, 5);
  const b = browser();
  rememberStageCount("long", 2, b);
  rememberStageCount("long", 11, b);
  assert.equal(b.values.get("bento:board-stages:long"), "11", "the real count is kept");
  assert.equal(rememberedStageCount("long", b), DEFAULT_STAGES.length, "and drawn as the default");
  rememberStageCount("long", 4, b);
  assert.equal(rememberedStageCount("long", b), DEFAULT_STAGES.length, "one past the cap is the default too");
  rememberStageCount("long", 1, b);
  assert.equal(rememberedStageCount("long", b), 1, "a shorter pipeline still draws its own width");
  rememberStageCount("huge", 5000, b);
  assert.equal(b.values.get("bento:board-stages:huge"), "999", "stored within three digits");
  assert.equal(rememberedStageCount("huge", b), DEFAULT_STAGES.length);
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
  assert.equal(skeletonLanes(2).length, 4, "a two stage project loads as four lanes");
  assert.equal(skeletonLanes(0).length, 2, "no stages still frames the board");
  assert.equal(skeletonLanes(6).length, 5, "more stages than fit draw the default five");
  assert.equal(skeletonLanes(12).length, 5);
  assert.equal(skeletonLanes(Number.NaN).length, DEFAULT_STAGES.length + 2);
});

test("loading a board's pipeline remembers its stage count, and a failed load remembers nothing", async () => {
  const b = browser();
  const pipeline = { id: "pipe", stages: [{}, {}, {}, {}, {}, {}] };
  const loaded = await loadBoardPipeline({ getPipeline: async (id: string) => (assert.equal(id, "six"), pipeline) }, "six", b);
  assert.equal(loaded, pipeline, "the pipeline comes back untouched");
  assert.equal(b.values.get("bento:board-stages:six"), "6");

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
  const result = { stages: 2, agents: 2, removedStages: [], skippedRepositories: [] };
  const returned = await importBoardPipeline(
    { importPipeline: async (id: string, yaml: string) => (assert.equal(id, "p"), assert.equal(yaml, "version: 1"), result) },
    "p",
    "version: 1",
    b,
  );
  assert.equal(returned, result);
  assert.equal(rememberedStageCount("p", b), 2);

  await assert.rejects(
    importBoardPipeline({ importPipeline: async () => { throw new Error("bad file"); } }, "p", "nope", b),
    /bad file/,
  );
  assert.equal(rememberedStageCount("p", b), 2, "a refused import leaves the count alone");
});

test("the board skeleton draws the stored count for its project", () => {
  const b = browser();
  rememberStageCount("two", 2, b);
  rememberStageCount("eleven", 11, b);
  const lanes = (projectId: string | null) =>
    renderToStaticMarkup(createElement(BoardSkeleton, { projectId, browser: b })).match(/<section class="lane"/g)?.length ?? 0;
  assert.equal(lanes("two"), 4, "backlog, two stages, done");
  assert.equal(lanes("eleven"), 5, "eleven stages draw the default five");
  assert.equal(lanes("unseen"), DEFAULT_STAGES.length + 2);
  assert.equal(lanes(null), DEFAULT_STAGES.length + 2);
});
