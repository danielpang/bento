import assert from "node:assert/strict";
import test from "node:test";
import { createBuildWatch, preloadErrorAction, readOwnBuild, staleAfter } from "./build-watch.js";

test("a page with no build of its own is never stale", () => {
  assert.equal(staleAfter(null, "abc", false), false);
});

test("a matching build keeps the page current, a different one makes it stale", () => {
  assert.equal(staleAfter("abc", "abc", false), false);
  assert.equal(staleAfter("abc", "def", false), true);
});

test("stale stays stale even when an old machine answers again", () => {
  assert.equal(staleAfter("abc", "abc", true), true);
});

test("the watch prompts on the first mismatch and notifies subscribers", () => {
  const watch = createBuildWatch("abc");
  let notified = 0;
  watch.subscribe(() => notified++);
  const before = watch.snapshot();
  assert.equal(before.stale, false);
  assert.equal(before.prompt, false);

  watch.note("abc");
  assert.equal(watch.snapshot().stale, false);

  watch.note("def");
  const after = watch.snapshot();
  assert.equal(after.stale, true);
  assert.equal(after.prompt, true);
  assert.equal(after.latest, "def");
  assert.notEqual(after, before, "a changed snapshot is a new object");
  assert.ok(notified >= 1);
});

test("an unchanged note does not publish a new snapshot", () => {
  const watch = createBuildWatch("abc");
  watch.note("def");
  const snapshot = watch.snapshot();
  watch.note("def");
  assert.equal(watch.snapshot(), snapshot);
});

test("Later hides the prompt for that build only", () => {
  const watch = createBuildWatch("abc");
  watch.note("def");
  watch.dismiss();
  assert.equal(watch.snapshot().prompt, false);
  assert.equal(watch.snapshot().stale, true, "dismissing does not make the page current");
  // An old machine answering with the page's own build changes nothing.
  watch.note("abc");
  assert.equal(watch.snapshot().prompt, false);
  // The next deploy asks again.
  watch.note("ghi");
  assert.equal(watch.snapshot().prompt, true);
});

test("a dev page never prompts", () => {
  const watch = createBuildWatch(null);
  watch.note("def");
  assert.equal(watch.snapshot().stale, false);
  assert.equal(watch.snapshot().prompt, false);
});

test("a preload error reloads once per build", () => {
  assert.deepEqual(preloadErrorAction("abc", null), { reload: true, mark: "abc" });
  assert.deepEqual(preloadErrorAction("abc", "abc"), { reload: false, mark: "abc" });
  // A reload landed on a new build: that one gets its own chance.
  assert.deepEqual(preloadErrorAction("def", "abc"), { reload: true, mark: "def" });
  assert.deepEqual(preloadErrorAction(null, null), { reload: true, mark: "no-build" });
  assert.deepEqual(preloadErrorAction(null, "no-build"), { reload: false, mark: "no-build" });
});

test("reads the build from the page's meta tag", () => {
  const doc = (content: string | null) => ({
    querySelector: () => (content === null ? null : { getAttribute: () => content }),
  }) as unknown as Pick<Document, "querySelector">;
  assert.equal(readOwnBuild(doc(" abc ")), "abc");
  assert.equal(readOwnBuild(doc("")), null);
  assert.equal(readOwnBuild(doc(null)), null);
  assert.equal(readOwnBuild(undefined), null);
});
