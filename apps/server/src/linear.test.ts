import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIssueTarget, stateTypeForStatus } from "./linear.js";

const project = {
  linearCreateIssues: true,
  linearTeamId: "team-default",
  linearProjectId: "project-default",
};

test("resolveIssueTarget files into the project's team and Linear project", () => {
  assert.deepEqual(resolveIssueTarget(project, null), {
    teamId: "team-default",
    projectId: "project-default",
  });
});

test("resolveIssueTarget prefers the team mapped to the card's project", () => {
  // And drops the Linear project: it belongs to the project's own team,
  // so it is not somewhere an issue in another team can be filed.
  assert.deepEqual(resolveIssueTarget(project, "team-mapped"), {
    teamId: "team-mapped",
    projectId: null,
  });
});

test("resolveIssueTarget keeps the project when the mapping names the project's team", () => {
  assert.deepEqual(resolveIssueTarget(project, "team-default"), {
    teamId: "team-default",
    projectId: "project-default",
  });
});

test("resolveIssueTarget files nothing without a team", () => {
  assert.equal(resolveIssueTarget({ ...project, linearTeamId: null }, null), null);
  // A mapping still gives one, even with no team configured.
  assert.deepEqual(resolveIssueTarget({ ...project, linearTeamId: null }, "team-mapped"), {
    teamId: "team-mapped",
    projectId: null,
  });
});

test("resolveIssueTarget files nothing when the project turned it off", () => {
  assert.equal(resolveIssueTarget({ ...project, linearCreateIssues: false }, null), null);
  assert.equal(resolveIssueTarget({ ...project, linearCreateIssues: false }, "team-mapped"), null);
});

test("resolveIssueTarget leaves the project unset when there is none", () => {
  assert.deepEqual(resolveIssueTarget({ ...project, linearProjectId: null }, null), {
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
