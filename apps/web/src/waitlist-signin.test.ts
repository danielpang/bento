import assert from "node:assert/strict";
import test from "node:test";
import {
  isWaitlistRequired,
  readWaitlistInvite,
  shouldShowWaitlistJoin,
  stripWaitlistParams,
  waitlistJoinPayload,
} from "./waitlist-signin.js";

test("open mode keeps the create-account form", () => {
  assert.equal(
    shouldShowWaitlistJoin({ mode: "open", invitedPrefill: false, refused: false }),
    false,
  );
});

test("waitlist mode replaces create-account unless the person was invited", () => {
  assert.equal(
    shouldShowWaitlistJoin({ mode: "waitlist", invitedPrefill: false, refused: false }),
    true,
  );
  assert.equal(
    shouldShowWaitlistJoin({ mode: "waitlist", invitedPrefill: true, refused: false }),
    false,
  );
  assert.equal(
    shouldShowWaitlistJoin({ mode: "waitlist", invitedPrefill: false, refused: false, lockEmail: true }),
    false,
  );
});

test("WAITLIST_REQUIRED switches to the join form and is not a verification 403", () => {
  assert.equal(isWaitlistRequired({ status: 403, code: "WAITLIST_REQUIRED" }), true);
  assert.equal(isWaitlistRequired({ status: 403, code: "EMAIL_NOT_VERIFIED" }), false);
  assert.equal(isWaitlistRequired({ status: 403 }), false);
  assert.equal(
    shouldShowWaitlistJoin({ mode: "open", invitedPrefill: false, refused: true }),
    true,
  );
});

test("the invite query preselects signup and email, then is stripped", () => {
  const invite = readWaitlistInvite("?signup=1&email=Ada%40Example.com&utm=keep");
  assert.deepEqual(invite, { signup: true, email: "Ada@Example.com" });
  assert.equal(stripWaitlistParams("/?signup=1&email=Ada%40Example.com&utm=keep"), "/?utm=keep");
  assert.equal(stripWaitlistParams("/?signup=1&email=a%40b.co"), "/");
});

test("duplicate-safe join payload sends console as the source", () => {
  assert.deepEqual(waitlistJoinPayload({ email: " ada@example.com ", name: " Ada " }), {
    email: "ada@example.com",
    name: "Ada",
    source: "console",
  });
  assert.deepEqual(waitlistJoinPayload({ email: "ada@example.com", name: "  " }), {
    email: "ada@example.com",
    source: "console",
  });
});
