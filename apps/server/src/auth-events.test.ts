import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authEventHook,
  authEventName,
  describeAuthEvent,
  methodFor,
  reportAuthEvent,
  type AuthHookContext,
} from "./auth-events.js";
import { recordingAnalytics } from "./test-analytics.js";

/** A better-auth hook context, as the after hook sees one. */
function hook(input: {
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
  cookie?: string;
  returned?: unknown;
  newSession?: { user: { id: string } } | null;
}): AuthHookContext {
  return {
    path: input.path,
    params: input.params,
    body: input.body,
    headers: new Headers(input.cookie ? { cookie: input.cookie } : {}),
    context: {
      returned: input.returned,
      newSession: input.newSession ?? null,
      socialProviders: [{ id: "github" }, { id: "google" }],
      authCookies: { sessionToken: { name: "better-auth.session_token" } },
    },
  };
}

/** What better-auth throws for a JSON refusal. */
const refused = (status: string, statusCode: number, code?: string) => ({
  status,
  statusCode,
  body: code ? { code, message: "refused" } : { message: "refused" },
});

/** What better-auth throws to send the browser somewhere. */
const redirected = (location: string) => ({ status: "FOUND", statusCode: 302, headers: new Headers({ location }) });

const session = { user: { id: "user-1" } };

test("an email sign in that minted a session is a sign in, for that user", () => {
  const event = describeAuthEvent(hook({ path: "/sign-in/email", newSession: session, returned: { token: "t", user: { id: "user-1" } } }));
  assert.deepEqual(event, {
    flow: "sign in",
    outcome: "succeeded",
    userId: "user-1",
    properties: { method: "email", route: "/sign-in/email" },
  });
  assert.equal(authEventName(event!), "sign in succeeded");
});

test("a wrong password is a sign in failure, counted but not an error", () => {
  const event = describeAuthEvent(hook({ path: "/sign-in/email", returned: refused("UNAUTHORIZED", 401, "INVALID_EMAIL_OR_PASSWORD") }));
  assert.deepEqual(event, {
    flow: "sign in",
    outcome: "failed",
    properties: { method: "email", route: "/sign-in/email", status: 401, code: "INVALID_EMAIL_OR_PASSWORD" },
  });

  const { analytics, events, exceptions } = recordingAnalytics();
  reportAuthEvent(analytics, event!);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "sign in failed");
  // Counted against the server, never a person: there is no user.
  assert.equal(events[0].userId, null);
  assert.equal(events[0].properties?.code, "INVALID_EMAIL_OR_PASSWORD");
  assert.equal(exceptions.length, 0, "the person's own mistake is not a fault of the server");
});

test("a fault the server or its configuration caused reaches error tracking, grouped by cause", () => {
  const event = describeAuthEvent(hook({ path: "/sign-in/social", body: { provider: "github" }, returned: refused("NOT_FOUND", 404, "PROVIDER_NOT_FOUND") }));
  const { analytics, events, exceptions } = recordingAnalytics();
  reportAuthEvent(analytics, event!);
  assert.equal(events[0]?.event, "sign in failed");
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].error.name, "AuthFailureError");
  assert.equal(exceptions[0].error.message, "sign in failed: PROVIDER_NOT_FOUND (github)");
  assert.equal(exceptions[0].userId, null);
  assert.equal(exceptions[0].properties?.$exception_fingerprint, "sign in failed:github:PROVIDER_NOT_FOUND");
  assert.equal(exceptions[0].properties?.code, "PROVIDER_NOT_FOUND");
});

test("a sign up is counted by its user row, not by the session it may also have minted", () => {
  // Without the verification gate a sign up signs the person in too.
  // That session is not a second event: auth.ts reports the sign up
  // from the database hook, where a hosted duplicate cannot pass for
  // a real one.
  assert.equal(describeAuthEvent(hook({ path: "/sign-up/email", newSession: session, returned: { token: "t", user: session.user } })), null);
  // A hosted deployment answers a duplicate exactly like a real sign
  // up, on purpose, so the after hook sees nothing to count either.
  assert.equal(describeAuthEvent(hook({ path: "/sign-up/email", returned: { token: null, user: { id: "synthetic" } } })), null);

  const refusal = describeAuthEvent(hook({ path: "/sign-up/email", returned: refused("UNPROCESSABLE_ENTITY", 422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") }));
  assert.equal(refusal?.flow, "sign up");
  assert.equal(refusal?.outcome, "failed");
  assert.equal(refusal?.properties.code, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
  const { analytics, exceptions } = recordingAnalytics();
  reportAuthEvent(analytics, refusal!);
  assert.equal(exceptions.length, 0);
});

test("a social start is a start, named for a configured provider only", () => {
  const started = describeAuthEvent(hook({ path: "/sign-in/social", body: { provider: "github", callbackURL: "/" }, returned: { url: "https://github.com/login/oauth/authorize?...", redirect: true } }));
  assert.deepEqual(started, { flow: "sign in", outcome: "started", properties: { method: "github", route: "/sign-in/social" } });

  // The provider name is caller-supplied. One that is not configured
  // must not become a property value of its own.
  const unknown = describeAuthEvent(hook({ path: "/sign-in/social", body: { provider: "evil-corp" }, returned: refused("NOT_FOUND", 404, "PROVIDER_NOT_FOUND") }));
  assert.equal(unknown?.properties.method, "unknown");

  // The id token branch signs the person in on the spot.
  const direct = describeAuthEvent(hook({ path: "/sign-in/social", body: { provider: "google", idToken: {} }, newSession: session, returned: { token: "t", user: session.user, redirect: false } }));
  assert.equal(direct?.outcome, "succeeded");
  assert.equal(direct?.properties.method, "google");
});

test("an OAuth callback that minted a session is a sign in, whatever page it lands on", () => {
  const event = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "github" },
    newSession: session,
    // The page asked for may carry its own error parameter; the session decides.
    returned: redirected("http://localhost:4400/sign-in?error=stale"),
  }));
  assert.deepEqual(event, { flow: "sign in", outcome: "succeeded", userId: "user-1", properties: { method: "github", route: "/callback/:id" } });
});

test("an OAuth callback that redirected with an error is a sign in failure, under the code better-auth appended", () => {
  const event = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "github" },
    returned: redirected("http://localhost:4400/api/auth/error?error=state_mismatch"),
  }));
  assert.deepEqual(event, {
    flow: "sign in",
    outcome: "failed",
    properties: { method: "github", route: "/callback/:id", status: 302, code: "state_mismatch" },
  });
  const { analytics, exceptions } = recordingAnalytics();
  reportAuthEvent(analytics, event!);
  assert.equal(exceptions.length, 1, "a state that would not verify is a fault worth an issue");
  assert.equal(exceptions[0].properties?.$exception_fingerprint, "sign in failed:github:state_mismatch");

  // A relative error page, and one that already carried an error of its own: the last one is better-auth's.
  const relative = describeAuthEvent(hook({ path: "/callback/:id", params: { id: "google" }, returned: redirected("/sign-in?error=stale&error=invalid_code") }));
  assert.equal(relative?.properties.code, "invalid_code");
  assert.equal(relative?.properties.method, "google");

  // Cancelling at the provider is the person's choice, not a fault.
  const declined = describeAuthEvent(hook({ path: "/callback/:id", params: { id: "github" }, returned: redirected("/?error=access_denied") }));
  const declinedReport = recordingAnalytics();
  reportAuthEvent(declinedReport.analytics, declined!);
  assert.equal(declinedReport.events[0]?.event, "sign in failed");
  assert.equal(declinedReport.exceptions.length, 0);
});

test("the account-link flow shares the callback and is not a sign in", () => {
  // Connecting GitHub from Settings: better-auth links and redirects
  // back without minting a session.
  const linked = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "github" },
    cookie: "better-auth.session_token=abc.sig",
    returned: redirected("/settings?tab=github&github=identity-connected"),
  }));
  assert.equal(linked, null);
  // A refused link is not a failed sign in either.
  const refusedLink = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "github" },
    cookie: "other=1; better-auth.session_token=abc.sig",
    returned: redirected("/settings?tab=github&github=identity-failed&error=account_already_linked_to_different_user"),
  }));
  assert.equal(refusedLink, null);
  // Without a session in hand the same refusal is a failed sign in.
  const refusedSignIn = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "github" },
    returned: redirected("/?error=unable_to_link_account"),
  }));
  assert.equal(refusedSignIn?.outcome, "failed");
});

test("a callback path naming no configured provider cannot mint a property value", () => {
  const event = describeAuthEvent(hook({
    path: "/callback/:id",
    params: { id: "not-a-provider" },
    returned: redirected("/api/auth/error?error=state_mismatch"),
  }));
  assert.equal(event?.properties.method, "unknown");
  // Nor can the error parameter a provider hands back.
  const odd = describeAuthEvent(hook({ path: "/callback/:id", params: { id: "github" }, returned: redirected("/?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E") }));
  assert.equal(odd?.properties.code, "other");
  const long = describeAuthEvent(hook({ path: "/callback/:id", params: { id: "github" }, returned: redirected(`/?error=${"a".repeat(65)}`) }));
  assert.equal(long?.properties.code, "other");
});

test("confirming an address and the device flow are sign ins; their protocol noise is not", () => {
  const verified = describeAuthEvent(hook({ path: "/verify-email", newSession: session, returned: redirected("/") }));
  assert.deepEqual(verified, { flow: "sign in", outcome: "succeeded", userId: "user-1", properties: { method: "email", route: "/verify-email" } });
  const expired = describeAuthEvent(hook({ path: "/verify-email", returned: redirected("/?error=TOKEN_EXPIRED") }));
  assert.equal(expired?.outcome, "failed");
  assert.equal(expired?.properties.code, "TOKEN_EXPIRED");
  const expiredReport = recordingAnalytics();
  reportAuthEvent(expiredReport.analytics, expired!);
  assert.equal(expiredReport.exceptions.length, 0, "an old link is not a fault");

  const cli = describeAuthEvent(hook({ path: "/device/token", newSession: session, returned: { access_token: "t" } }));
  assert.deepEqual(cli, { flow: "sign in", outcome: "succeeded", userId: "user-1", properties: { method: "device", route: "/device/token" } });
  // The CLI polls until the person approves; "pending" is the protocol, not a failure.
  const pending = describeAuthEvent(hook({ path: "/device/token", returned: { status: "BAD_REQUEST", statusCode: 400, body: { error: "authorization_pending" } } }));
  assert.equal(pending, null);
});

test("sessions minted elsewhere, and every other route, are left alone", () => {
  // A page load past the session's update age mints a fresh session.
  assert.equal(describeAuthEvent(hook({ path: "/get-session", newSession: session, returned: { session: {}, user: session.user } })), null);
  assert.equal(describeAuthEvent(hook({ path: "/organization/set-active", newSession: session, returned: {} })), null);
  assert.equal(describeAuthEvent(hook({ path: "/update-user", newSession: session, returned: {} })), null);
  assert.equal(describeAuthEvent(hook({ path: "/get-session", returned: refused("UNAUTHORIZED", 401) })), null);
  assert.equal(describeAuthEvent(hook({ path: "/sign-out", returned: { success: true } })), null);
  assert.equal(describeAuthEvent(hook({ path: "/link-social", returned: refused("UNAUTHORIZED", 401) })), null);
  // A refusal with no code still counts, under its status.
  const bare = describeAuthEvent(hook({ path: "/sign-in/email", returned: refused("BAD_REQUEST", 400) }));
  assert.equal(bare?.properties.code, "http_400");
});

test("the method names how the person signed in, from the route", () => {
  const at = (path: string, extra: Partial<Parameters<typeof hook>[0]> = {}) => methodFor(hook({ path, ...extra }));
  assert.equal(at("/sign-in/email"), "email");
  assert.equal(at("/sign-up/email"), "email");
  assert.equal(at("/verify-email"), "email");
  assert.equal(at("/device/token"), "device");
  assert.equal(at("/callback/:id", { params: { id: "google" } }), "google");
  assert.equal(at("/sign-in/social", { body: { provider: "github" } }), "github");
  assert.equal(at("/sign-in/magic-link"), "magic-link");
  assert.equal(methodFor(null), "unknown");
});

test("a report that throws never reaches better-auth", () => {
  const seen: string[] = [];
  const report = authEventHook((event) => {
    seen.push(authEventName(event));
    throw new Error("posthog is down");
  });
  assert.doesNotThrow(() => report(hook({ path: "/sign-in/email", newSession: session, returned: {} })));
  assert.deepEqual(seen, ["sign in succeeded"]);
  assert.doesNotThrow(() => report(hook({ path: "/get-session", returned: {} })));
  assert.equal(seen.length, 1);
});
