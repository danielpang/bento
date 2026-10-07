import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STAGES } from "@bento/core";
import { rememberedStageCount, rememberStageCount } from "./board-shape.js";

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
  for (const junk of ["", "three", "2.5", "-1", "9999"]) {
    b.values.set("bento:board-stages:p", junk);
    assert.equal(rememberedStageCount("p", b), DEFAULT_STAGES.length, `stored ${JSON.stringify(junk)}`);
  }
  rememberStageCount("q", -3, b);
  rememberStageCount("q", Number.NaN, b);
  assert.equal(b.values.has("bento:board-stages:q"), false, "nonsense is never written");
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
