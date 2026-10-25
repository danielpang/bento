import assert from "node:assert/strict";
import test from "node:test";
import { deviceApprovalCallbackUrl } from "./device-approval.js";

test("authentication returns to approval with the pending device code", () => {
  const callback = new URL(deviceApprovalCallbackUrl("ABCD-1234"), "https://app.usebento.ai");
  assert.equal(callback.pathname, "/device");
  assert.equal(callback.searchParams.get("user_code"), "ABCD-1234");
});

test("authentication without a supplied code returns to manual code entry", () => {
  assert.equal(deviceApprovalCallbackUrl(""), "/device");
});

test("device codes cannot inject redirect parameters or change the callback origin", () => {
  const code = "A+B &redirect=https://example.com/#fragment";
  const callback = new URL(deviceApprovalCallbackUrl(code), "https://app.usebento.ai");
  assert.equal(callback.origin, "https://app.usebento.ai");
  assert.equal(callback.pathname, "/device");
  assert.deepEqual([...callback.searchParams], [["user_code", code]]);
  assert.equal(callback.hash, "");
});
