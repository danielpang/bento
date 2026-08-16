import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIssueTarget, stateTypeForStatus } from "./linear.js";

const connection = {
  createIssues: true,
  defaultTeamId: "team-default",
  defaultLinearProjectId: "project-default",
};

test("resolveIssueTarget files into the default team and project", () => {
  assert.deepEqual(resolveIssueTarget(connection, null), {
    teamId: "team-default",
    projectId: "project-default",
  });
});

test("resolveIssueTarget prefers the team mapped to the card's project", () => {
  // And drops the Linear project: it belongs to the default team, so it
  // is not somewhere an issue in another team can be filed.
  assert.deepEqual(resolveIssueTarget(connection, "team-mapped"), {
    teamId: "team-mapped",
    projectId: null,
  });
});

test("resolveIssueTarget keeps the project when the mapping names the default team", () => {
  assert.deepEqual(resolveIssueTarget(connection, "team-default"), {
    teamId: "team-default",
    projectId: "project-default",
  });
});

test("resolveIssueTarget files nothing without a team", () => {
  assert.equal(resolveIssueTarget({ ...connection, defaultTeamId: null }, null), null);
  // A mapping still gives one, even with no default configured.
  assert.deepEqual(resolveIssueTarget({ ...connection, defaultTeamId: null }, "team-mapped"), {
    teamId: "team-mapped",
    projectId: null,
  });
});

test("resolveIssueTarget files nothing when the setting is off", () => {
  assert.equal(resolveIssueTarget({ ...connection, createIssues: false }, null), null);
  assert.equal(resolveIssueTarget({ ...connection, createIssues: false }, "team-mapped"), null);
});

test("resolveIssueTarget leaves the project unset when there is none", () => {
  assert.deepEqual(resolveIssueTarget({ ...connection, defaultLinearProjectId: null }, null), {
    teamId: "team-default",
    projectId: null,
  });
});

test("stateTypeForStatus maps the lifecycle Linear cares about", () => {
  assert.equal(stateTypeForStatus("backlog"), "backlog");
  assert.equal(stateTypeForStatus("active"), "started");
  assert.equal(stateTypeForStatus("gated"), "started");
  assert.equal(stateTypeForStatus("done"), "completed");
  assert.equal(stateTypeForStatus("cancelled"), "canceled");
  assert.equal(stateTypeForStatus("something-else"), null);
});
