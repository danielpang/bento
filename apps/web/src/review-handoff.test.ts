import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, GateCheck, RunArtifact } from "@bento/api-client";
import { ReviewHandoff } from "./components/ReviewHandoff.js";

const noop = () => {};
function render(checks: GateCheck[] = [], artifacts: RunArtifact[] = []) {
  return renderToStaticMarkup(createElement(ReviewHandoff, {
    run: { id: "latest", status: "succeeded" } as AgentRun,
    changes: null,
    gate: { status: "gated", currentStageId: "review", checks },
    artifacts,
    pending: false,
    failed: false,
    onChanges: noop,
    onChat: noop,
    onArtifact: noop,
  }));
}

test("unavailable changes and unevaluated requirements are not claimed as success", () => {
  const html = render();
  assert.match(html, /Changes unavailable/);
  assert.match(html, /No automated requirements recorded/);
  assert.doesNotMatch(html, /0 files changed|requirements passed/);
});

test("manual approval is not included in the automated requirement count", () => {
  const checks: GateCheck[] = [
    { id: "run", criterion: { type: "run_succeeded" }, status: "passed", detail: null },
    { id: "ci", criterion: { type: "checks_pass" }, status: "failed", detail: null },
    { id: "human", criterion: { type: "manual" }, status: "pending", detail: null },
  ];
  assert.match(render(checks), /1 of 2 requirements passed. Some need attention/);
});

test("the handoff only links artifacts from the latest stage run", () => {
  const artifacts = [
    { id: "old", runId: "previous", path: "old-report.md" },
    { id: "new", runId: "latest", path: "current-report.md" },
  ] as RunArtifact[];
  const html = render([], artifacts);
  assert.match(html, /current-report.md/);
  assert.doesNotMatch(html, /old-report.md/);
});
