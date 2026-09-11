import assert from "node:assert/strict";
import test from "node:test";
import { createBuildWatch } from "./build-watch.js";

test("prompts on the first build that is not the page's, and notifies", () => {
  const watch = createBuildWatch("abc");
  let notified = 0;
  watch.subscribe(() => notified++);
  const before = watch.snapshot();
  watch.note("abc");
  assert.equal(watch.snapshot().prompt, false);
  assert.equal(watch.snapshot(), before, "nothing changed, same snapshot");
  watch.note("def");
  assert.equal(watch.snapshot().prompt, true);
  assert.equal(notified, 1);
});

test("an old machine answering with the page's own build does not clear it", () => {
  const watch = createBuildWatch("abc");
  watch.note("def");
  watch.note("abc");
  assert.equal(watch.snapshot().prompt, true);
});

test("Later hides the prompt for that build only", () => {
  const watch = createBuildWatch("abc");
  watch.note("def");
  watch.dismiss();
  assert.equal(watch.snapshot().prompt, false);
  watch.note("def");
  watch.note("abc");
  assert.equal(watch.snapshot().prompt, false);
  watch.note("ghi");
  assert.equal(watch.snapshot().prompt, true);
});

test("a page with no build of its own never prompts", () => {
  const watch = createBuildWatch(null);
  watch.note("def");
  assert.equal(watch.snapshot().prompt, false);
});
