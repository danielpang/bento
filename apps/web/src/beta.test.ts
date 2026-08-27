import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BetaOnly, BetaTestersScope, useBetaTesters } from "./beta.js";

test("BetaOnly hides children while the tester flag is off", () => {
  const html = renderToStaticMarkup(
    createElement(BetaTestersScope, { enabled: false, children: createElement(BetaOnly, { children: "secret" }) }),
  );
  assert.equal(html, "");
});

test("BetaOnly shows children when the tester flag is on", () => {
  const html = renderToStaticMarkup(
    createElement(BetaTestersScope, { enabled: true, children: createElement(BetaOnly, { children: "secret" }) }),
  );
  assert.equal(html, "secret");
});

test("useBetaTesters is false until a scope turns it on", () => {
  function Probe() {
    return useBetaTesters() ? "yes" : "no";
  }
  assert.equal(renderToStaticMarkup(createElement(Probe)), "no");
  assert.equal(
    renderToStaticMarkup(createElement(BetaTestersScope, { enabled: true, children: createElement(Probe) })),
    "yes",
  );
});
