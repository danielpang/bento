import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SANDBOX_CAPACITY_MESSAGE, isSandboxCapacityError } from "@bento/core";
import { CapacityNotice } from "./components/CapacityNotice.js";
import { ChatRow } from "./components/AgentSession.js";
import { plannerFailure } from "./swarm/failures.js";

const error = `sandbox provisioning failed: ${SANDBOX_CAPACITY_MESSAGE}`;

test("capacity notice is accessible and offers retry only when an action is available", () => {
  const html = renderToStaticMarkup(createElement(CapacityNotice, { onRetry() {}, busy: true }));
  assert.match(html, /role="status"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /small team/);
  assert.match(html, /agent hours/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(CapacityNotice)), /<button/);
});

test("the actual chat result renders the capacity notice, and ordinary failures keep their details", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(ChatRow, { item: { key: "run", kind: "result", ok: false, error: text }, showDetail: true }));
  assert.match(render(error), /capacity-notice/);
  assert.doesNotMatch(render(error), /sandbox provisioning failed/);
  assert.doesNotMatch(render("test failed"), /capacity-notice/);
  assert.match(render("test failed"), /test failed/);
  assert.equal(plannerFailure(error).beforeAgent, true);
  assert.match(plannerFailure(error).title, /capacity/);
});

test("an agent mentioning capacity later in its output does not become a service error", () => {
  assert.equal(isSandboxCapacityError(error), true);
  assert.equal(isSandboxCapacityError(`Agent failed\n${error}`), false);
  assert.equal(isSandboxCapacityError(null), false);
});
