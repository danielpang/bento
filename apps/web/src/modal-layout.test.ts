import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "./components/Modal.js";

function renderModal(children?: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(
      Modal,
      {
        title: "New agent",
        onClose() {},
        actions: createElement("button", { className: "btn btn-primary" }, "Save changes"),
      },
      children,
    ),
  );
}

test("a form modal keeps actions outside the scrolling body", () => {
  const html = renderModal(createElement("label", { className: "field" }, "Skill"));
  const body = html.indexOf('class="modal-body"');
  const actions = html.indexOf('class="modal-actions"');
  assert.ok(body >= 0, "fields live in a scrolling body");
  assert.ok(actions >= 0, "actions stay on the panel");
  assert.ok(body < actions, "Save stays below the fields, not inside the scroller");
  assert.match(html, /modal-body[\s\S]*Skill[\s\S]*modal-actions[\s\S]*Save changes/);
});

test("a confirm with no fields has no empty scrolling body", () => {
  const html = renderModal();
  assert.doesNotMatch(html, /class="modal-body"/);
  assert.match(html, /class="modal-actions"/);
});
