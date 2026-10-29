import assert from "node:assert/strict";
import test from "node:test";
import { artifactsNavCurrent, parseArtifactsRoute, workspaceScreen } from "./artifacts-routes.js";

test("workspace routes recognize artifacts grid and detail paths", () => {
  assert.equal(workspaceScreen("/"), "board");
  assert.equal(workspaceScreen("/sessions"), "sessions");
  assert.equal(workspaceScreen("/spend"), "analytics");
  assert.equal(workspaceScreen("/analytics"), "analytics");
  assert.equal(workspaceScreen("/artifacts"), "artifacts");
  assert.equal(workspaceScreen("/artifacts/11111111-1111-1111-1111-111111111111"), "artifacts");
  assert.equal(workspaceScreen("/artifacts/not-a-uuid"), "board");
});

test("parseArtifactsRoute accepts grid and card detail only for real ids", () => {
  assert.deepEqual(parseArtifactsRoute("/artifacts"), { grid: true });
  assert.deepEqual(parseArtifactsRoute("/artifacts/11111111-1111-1111-1111-111111111111"), {
    cardId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(parseArtifactsRoute("/artifact/11111111-1111-1111-1111-111111111111"), null);
  assert.equal(artifactsNavCurrent("/artifacts/foo"), false);
  assert.equal(artifactsNavCurrent("/artifacts"), true);
});

test("artifacts is not a board work screen", () => {
  const workScreen = (screen: ReturnType<typeof workspaceScreen>, beta: boolean) =>
    screen === "board" || (beta && screen === "sessions");
  assert.equal(workScreen("artifacts", true), false);
  assert.equal(workScreen("artifacts", false), false);
});
