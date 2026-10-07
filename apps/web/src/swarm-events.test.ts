import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isSwarmEvent } from "./swarm/events.js";

/**
 * One channel, two boards.
 *
 * The pipeline's handler ends in a debounced full refresh, so anything
 * it does not recognise costs every viewer of that board a refetch of
 * stages, features and usage. A swarm emits a task event per node it
 * touches, which is why this question is asked before anything else.
 */
test("a swarm's events are the swarm board's, and the pipeline ignores them", () => {
  assert.equal(isSwarmEvent({ type: "swarm_updated", swarmId: "s1", status: "running" }), true);
  assert.equal(isSwarmEvent({ type: "swarm_task_updated", swarmId: "s1", taskId: "t1" }), true);
});

test("the card board's own events still get through", () => {
  for (const type of ["run_updated", "run_output", "feature_updated", "feature_deleted", "stage_updated"]) {
    assert.equal(isSwarmEvent({ type, featureId: "f1" }), false, type);
  }
});

test("an event with nothing to read is not mistaken for either board's", () => {
  assert.equal(isSwarmEvent(null), false);
  assert.equal(isSwarmEvent(undefined), false);
  assert.equal(isSwarmEvent({}), false);
  assert.equal(isSwarmEvent("swarm_updated"), false);
  assert.equal(isSwarmEvent({ type: 7 }), false);
  // Named for a swarm without being one of its events.
  assert.equal(isSwarmEvent({ type: "swarmish" }), false);
});

/**
 * The rule is only worth anything at its one call site, and the board
 * screen is not a thing this suite can drive: it wants an EventSource,
 * a session and a project. So the source is read, and what is asserted
 * is that the question is asked before the handler can reach the
 * refresh that made a swarm expensive for everyone else.
 */
test("the board's stream asks the question before it falls through to a refresh", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("client.streamBoard("));
  const guard = handler.indexOf("isSwarmEvent(");
  const refresh = handler.indexOf("void refresh()");
  assert.ok(guard > -1, "the board stream must ignore the other board's events");
  assert.ok(refresh > -1, "and the debounced refresh is still what everything else falls through to");
  assert.ok(guard < refresh, "the guard comes first, or the refresh happens anyway");
});
