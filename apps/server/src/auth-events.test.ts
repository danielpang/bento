import { test } from "node:test";
import assert from "node:assert/strict";
import type { Analytics, ServerEvent } from "./analytics.js";
import { classifyAuthRequest, reportAuthEvents, userFromSessionCookie } from "./auth-events.js";

/** Records what would have gone to PostHog. */
function recorder() {
  const events: ServerEvent[] = [];
  const exceptions: { error: Error; properties?: Record<string, unknown> }[] = [];
  const analytics: Analytics = {
    capture: (event) => {
      events.push(event);
    },
    captureException: (error, _userId, _organizationId, properties) => {
      exceptions.push({ error: error as Error, properties });
    },
    shutdown: async () => {},
  };
  return { analytics, events, exceptions };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

function post(path: string, body: unknown) {
  return new Request(`http://localhost:4400${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const callback = (query: string) =>
  new Request(`http://localhost:4400/api/auth/callback/github?${query}`, { method: "GET" });

test("a sign in that worked is counted for the user it signed in", async () => {
  const { analytics, events, exceptions } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => json(200, { token: "t", user: { id: "user-1", email: "a@b.test" } }),
  );
  const res = await handler(post("/api/auth/sign-in/email", { email: "a@b.test", password: "right" }));
  assert.equal(res.status, 200);
  // The caller still gets the body: reporting read a clone.
  assert.equal(((await res.json()) as { user: { id: string } }).user.id, "user-1");

  assert.deepEqual(events, [
    {
      event: "sign in succeeded",
      userId: "user-1",
      properties: { method: "email", stage: "request", route: "sign-in/email", status: 200 },
    },
  ]);
  // A success is not an error.
  assert.equal(exceptions.length, 0);
});

test("a wrong password is a sign in failure, counted and sent to error tracking", async () => {
  const { analytics, events, exceptions } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }),
  );

  const res = await handler(post("/api/auth/sign-in/email", { email: "a@b.test", password: "wrong" }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "sign in failed");
  assert.deepEqual(events[0].properties, {
    method: "email",
    stage: "request",
    route: "sign-in/email",
    status: 401,
    code: "INVALID_EMAIL_OR_PASSWORD",
    message: "Invalid email or password",
  });
  // Counted against the server, never a person: there is no user.
  assert.equal(events[0].userId, null);

  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].error.name, "AuthFailureError");
  assert.equal(exceptions[0].error.message, "sign in failed: INVALID_EMAIL_OR_PASSWORD (email)");
  assert.equal(exceptions[0].properties?.$exception_fingerprint, "sign in failed:email:INVALID_EMAIL_OR_PASSWORD");
  assert.equal(exceptions[0].properties?.code, "INVALID_EMAIL_OR_PASSWORD");
});

test("sign up outcomes are sign up events", async () => {
  const { analytics, events, exceptions } = recorder();
  const created = reportAuthEvents(
    () => analytics,
    async () => json(200, { token: "t", user: { id: "user-2" } }),
  );
  await created(post("/api/auth/sign-up/email", { email: "a@b.test", password: "long-enough", name: "A" }));
  assert.equal(events[0]?.event, "sign up succeeded");
  assert.equal(events[0]?.userId, "user-2");

  const refused = reportAuthEvents(
    () => analytics,
    async () => json(422, { code: "USER_ALREADY_EXISTS", message: "User already exists" }),
  );
  await refused(post("/api/auth/sign-up/email", { email: "a@b.test", password: "long-enough", name: "A" }));
  assert.equal(events[1]?.event, "sign up failed");
  assert.equal(events[1]?.properties?.code, "USER_ALREADY_EXISTS");
  assert.equal(events[1]?.properties?.method, "email");
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0]?.error.message, "sign up failed: USER_ALREADY_EXISTS (email)");
});

test("starting a social sign in is not yet an outcome, but a refusal to start is", async () => {
  const { analytics, events } = recorder();
  const started = reportAuthEvents(
    () => analytics,
    async () => json(200, { url: "https://github.com/login/oauth/authorize?...", redirect: true }),
  );
  await started(post("/api/auth/sign-in/social", { provider: "github", callbackURL: "/" }));
  assert.equal(events.length, 0, "the browser is on its way to the provider; nothing has been decided");

  let seenByHandler: unknown = null;
  const refused = reportAuthEvents(
    () => analytics,
    async (request) => {
      seenByHandler = await request.json();
      return json(404, { code: "PROVIDER_NOT_FOUND", message: "Provider not found" });
    },
  );
  await refused(post("/api/auth/sign-in/social", { provider: "github", callbackURL: "/" }));
  // The handler still reads the body: the provider name came from a clone.
  assert.deepEqual(seenByHandler, { provider: "github", callbackURL: "/" });
  assert.equal(events[0]?.event, "sign in failed");
  assert.equal(events[0]?.properties?.method, "github");
  assert.equal(events[0]?.properties?.code, "PROVIDER_NOT_FOUND");
});

test("an OAuth callback that lands on the board is a sign in, for the user the cookie names", async () => {
  const { analytics, events, exceptions } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost:4400/", "set-cookie": "better-auth.session_token=abc.sig; Path=/" },
      }),
    {
      userFromResponse: async (response) =>
        response.headers.get("set-cookie")?.startsWith("better-auth.session_token=abc") ? "user-3" : null,
    },
  );
  const res = await handler(callback("code=abc&state=xyz"));
  assert.equal(res.status, 302);
  assert.deepEqual(events, [
    {
      event: "sign in succeeded",
      userId: "user-3",
      properties: { method: "github", stage: "callback", route: "callback/github", status: 302 },
    },
  ]);
  assert.equal(exceptions.length, 0);
});

test("a callback success with nobody to name is still counted", async () => {
  const { analytics, events } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => redirect("http://localhost:4400/"),
  );
  await handler(callback("code=abc&state=xyz"));
  assert.equal(events[0]?.event, "sign in succeeded");
  assert.equal(events[0]?.userId, null);
});

test("an OAuth callback that redirects with an error code is a sign in failure", async () => {
  const { analytics, events, exceptions } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => redirect("http://localhost:4400/api/auth/error?error=state_mismatch"),
  );
  const res = await handler(callback("code=abc&state=xyz"));
  assert.equal(res.status, 302);
  assert.equal(events[0]?.event, "sign in failed");
  assert.deepEqual(events[0]?.properties, {
    method: "github",
    stage: "callback",
    route: "callback/github",
    status: 302,
    code: "state_mismatch",
  });
  assert.equal(exceptions[0]?.error.message, "sign in failed: state_mismatch (github)");
});

test("a callback error may land on a relative page with a description", async () => {
  const { analytics, events } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => redirect("/settings?tab=github&github=identity-failed&error=access_denied&error_description=The+user+said+no"),
  );
  await handler(callback("error=access_denied"));
  assert.equal(events[0]?.properties?.code, "access_denied");
  assert.equal(events[0]?.properties?.message, "The user said no");
});

test("a refusal without a JSON body still counts, under the status", async () => {
  const { analytics, events } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => new Response("Too Many Requests", { status: 429 }),
  );
  await handler(post("/api/auth/sign-in/email", { email: "a@b.test", password: "x" }));
  assert.equal(events[0]?.properties?.code, "http_429");
  assert.equal(events[0]?.properties?.message, undefined);
});

test("other auth routes are left alone", async () => {
  const { analytics, events, exceptions } = recorder();
  const handler = reportAuthEvents(
    () => analytics,
    async () => json(401, { code: "UNAUTHORIZED", message: "Unauthorized" }),
  );
  // A signed-out page load asks for the session and hears no. That is
  // not a failed sign in.
  await handler(new Request("http://localhost:4400/api/auth/get-session", { method: "GET" }));
  await handler(new Request("http://localhost:4400/api/projects", { method: "GET" }));
  await handler(post("/api/auth/organization/create", { name: "x" }));
  assert.equal(events.length, 0);
  assert.equal(exceptions.length, 0);
});

test("without an analytics client the handler is called untouched", async () => {
  let calls = 0;
  const handler = reportAuthEvents(
    () => null,
    async () => {
      calls += 1;
      return json(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
    },
  );
  const res = await handler(post("/api/auth/sign-in/email", { email: "a@b.test", password: "wrong" }));
  assert.equal(calls, 1);
  assert.equal(res.status, 401);
});

test("a reporter that throws never changes the response", async () => {
  const analytics: Analytics = {
    capture: () => {
      throw new Error("posthog is down");
    },
    captureException: () => {},
    shutdown: async () => {},
  };
  const handler = reportAuthEvents(
    () => analytics,
    async () => json(401, { code: "INVALID_EMAIL_OR_PASSWORD" }),
  );
  const res = await handler(post("/api/auth/sign-in/email", { email: "a@b.test", password: "wrong" }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: "INVALID_EMAIL_OR_PASSWORD" });
});

test("the session cookie a response set is handed back to better-auth as a request would carry it", async () => {
  let seen: string | null = null;
  const resolve = userFromSessionCookie({
    api: {
      async getSession({ headers }) {
        seen = headers.get("cookie");
        return { user: { id: "user-4" }, session: {} };
      },
    },
  });
  const response = new Response(null, { status: 302, headers: { location: "/" } });
  response.headers.append("set-cookie", "__Secure-better-auth.session_token=tok.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax");
  response.headers.append("set-cookie", "__Secure-better-auth.state=; Max-Age=0; Path=/");
  assert.equal(await resolve(response), "user-4");
  assert.equal(seen, "__Secure-better-auth.session_token=tok.sig; __Secure-better-auth.state=");

  // No cookie, no lookup.
  let looked = false;
  const none = userFromSessionCookie({
    api: {
      async getSession() {
        looked = true;
        return null;
      },
    },
  });
  assert.equal(await none(new Response(null, { status: 302 })), null);
  assert.equal(looked, false);
});

test("only the doors are classified", () => {
  const at = (method: string, path: string) => classifyAuthRequest(method, `http://localhost:4400${path}`);
  assert.equal(at("POST", "/api/auth/sign-in/email")?.flow, "sign in");
  assert.equal(at("POST", "/api/auth/sign-in/email")?.decides, true);
  assert.equal(at("POST", "/api/auth/sign-in/social")?.method, null);
  assert.equal(at("POST", "/api/auth/sign-in/social")?.decides, false);
  assert.equal(at("POST", "/api/auth/sign-up/email")?.flow, "sign up");
  assert.equal(at("GET", "/api/auth/callback/google")?.method, "google");
  assert.equal(at("GET", "/api/auth/callback/google")?.decides, true);
  // The POST form of the callback only redirects to its GET form.
  assert.equal(at("POST", "/api/auth/callback/google"), null);
  assert.equal(at("GET", "/api/auth/sign-in/email"), null);
  assert.equal(at("POST", "/api/auth/sign-in"), null);
  assert.equal(at("POST", "/api/auth/sign-out"), null);
  assert.equal(at("POST", "/api/auth/callback"), null);
  assert.equal(at("POST", "/api/other/sign-in/email"), null);
});
