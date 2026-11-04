import assert from "node:assert/strict";
import test from "node:test";
import { deviceApprovalCallbackUrl, deviceSignInAgainUrl, signedInAsOther, withoutAutoProvider } from "./device-approval.js";

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

test("the auto provider leaves the address once acted on, keeping the code and email", () => {
  const next = withoutAutoProvider("https://app.usebento.ai/device?user_code=ABCD-1234&email=a%40b.co&provider=github");
  const url = new URL(next, "https://app.usebento.ai");
  assert.equal(url.pathname, "/device");
  assert.deepEqual([...url.searchParams], [["user_code", "ABCD-1234"], ["email", "a@b.co"]]);
  assert.equal(withoutAutoProvider("https://app.usebento.ai/device?provider=github"), "/device");
});

test("signing in again keeps the code and the address the app asked for", () => {
  const url = new URL(deviceSignInAgainUrl("ABCD-1234", " a@b.co "), "https://app.usebento.ai");
  assert.equal(url.pathname, "/device");
  assert.deepEqual([...url.searchParams], [["user_code", "ABCD-1234"], ["email", "a@b.co"]]);
  assert.equal(deviceSignInAgainUrl("ABCD-1234", ""), "/device?user_code=ABCD-1234");
  assert.equal(deviceSignInAgainUrl("", ""), "/device");
});

test("a requested address that differs from the session is flagged, ignoring case", () => {
  assert.equal(signedInAsOther("Alex@Example.com", "alex@example.com"), false);
  assert.equal(signedInAsOther("sam@example.com", "alex@example.com"), true);
  assert.equal(signedInAsOther(null, "alex@example.com"), false);
  assert.equal(signedInAsOther("  ", "alex@example.com"), false);
});
