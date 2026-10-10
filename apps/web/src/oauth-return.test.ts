import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthFailureMessage, withoutOAuthError } from "./oauth-return.js";

test("a mismatched OAuth state tells the person to start again in this tab", () => {
  const message = oauthFailureMessage("?error=state_mismatch");
  assert.match(message, /did not finish/);
  assert.match(message, /this tab/);
  assert.equal(message.includes("state_mismatch"), false);
  assert.equal(oauthFailureMessage("?error=state_security_mismatch"), message);
});

test("cancelling at the provider is its own sentence", () => {
  assert.match(oauthFailureMessage("?error=access_denied"), /cancelled/);
});

test("any other OAuth error stays generic and does not echo the code", () => {
  const message = oauthFailureMessage("?error=%3Cscript%3E");
  assert.equal(message, "Sign in did not finish. Try again.");
  assert.equal(message.includes("script"), false);
  assert.equal(oauthFailureMessage(""), "");
  assert.equal(oauthFailureMessage("?github=identity-failed&error=state_mismatch"), "");
});

test("the error leaves the address, and an invitation id stays", () => {
  assert.equal(withoutOAuthError("?error=state_mismatch&error_description=nope"), "");
  assert.equal(withoutOAuthError("?id=inv_1&error=state_mismatch"), "id=inv_1");
  assert.equal(withoutOAuthError("?id=inv_1"), null);
  assert.equal(withoutOAuthError("?github=identity-failed&error=email_doesn't_match"), null);
});
