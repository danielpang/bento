import type { Analytics } from "./analytics.js";

/**
 * Sign in and sign up outcomes, reported to PostHog.
 *
 * better-auth owns these routes, and none of what happens on them is
 * an exception: a refusal is a JSON status, a failed OAuth callback is
 * a redirect carrying an `error` code, and a success is a session
 * cookie. So until this existed a broken sign in left a log line on
 * the machine and nothing anywhere else: the private GitHub App that
 * answered every outside user with a 404 was found by a user, not by
 * a chart. Successes are reported as well as failures, because a
 * failure count only means something next to the attempts, and a
 * sign in that worked belongs on the person's timeline.
 *
 * The facts come from better-auth's own after hook rather than from
 * the HTTP exchange. The hook runs after every endpoint with the
 * session it minted (`newSession`) and whatever it answered or threw
 * (`returned`), so nothing here parses a response body, sniffs a
 * redirect, or looks the session up a second time. Two things the
 * HTTP layer could not tell apart fall out of that: the OAuth
 * callback also serves the "connect your GitHub account" flow, which
 * mints no session and is not a sign in; and on the hosted deployment
 * a duplicate sign up is answered exactly like a real one, on
 * purpose, so a sign up counts only when a user row exists (the
 * database hook in auth.ts).
 *
 * A success is attributed to the user. A failure has no user, so it
 * counts against the server rather than a person, and nothing that
 * came from the request rides along beyond the error code, which is
 * checked against a short alphabet: no address, no password, no free
 * text from a provider.
 */

export type AuthFlow = "sign in" | "sign up";
export type AuthOutcome = "started" | "succeeded" | "failed";

export interface AuthEvent {
  flow: AuthFlow;
  outcome: AuthOutcome;
  /** The user a success signed in or created. Never set on a failure. */
  userId?: string;
  properties: {
    /** "email", "device", or the id of a configured social provider. */
    method: string;
    /** better-auth's route template, relative to its base path, such as "/callback/:id". */
    route: string;
    /** On a failure: the HTTP status. */
    status?: number;
    /** On a failure: better-auth's error code, or the `error` a callback redirected with. */
    code?: string;
  };
}

/** The PostHog event name: "sign in failed", "sign up succeeded", and so on. */
export function authEventName(event: AuthEvent): string {
  return `${event.flow} ${event.outcome}`;
}

/**
 * The slice of better-auth's endpoint context this reads. The after
 * hook and the database hooks both carry it; `path` is the route
 * template, so a callback reads "/callback/:id" with the provider in
 * `params`.
 */
export interface AuthHookContext {
  path?: string | undefined;
  params?: Record<string, unknown> | undefined;
  body?: unknown;
  headers?: Headers | undefined;
  context: {
    returned?: unknown;
    newSession?: { user: { id: string } } | null | undefined;
    socialProviders?: { id: string }[] | undefined;
    authCookies?: { sessionToken: { name: string } } | undefined;
  };
}

/**
 * Routes where a minted session means somebody signed in. Not every
 * session does: a plain get-session past its update age, set-active
 * organization, and update-user all mint one too, and none of those
 * is anyone signing in. Device token is how the CLI and TUI sign in;
 * verify-email is the first sign in on a deployment that requires
 * confirmation, since sign up does not sign anyone in there.
 */
const SIGN_IN_ROUTES = new Set(["/callback/:id", "/verify-email", "/device/token"]);

function isSignInRoute(route: string): boolean {
  return route.startsWith("/sign-in/") || SIGN_IN_ROUTES.has(route);
}

/**
 * Sign in refusals worth counting. The device token route is left out:
 * the CLI polls it every few seconds and hears "authorization pending"
 * until the person approves, which is the protocol working, not a
 * failed sign in.
 */
function reportsRefusals(route: string): boolean {
  return route.startsWith("/sign-in/") || route.startsWith("/sign-up/") || route === "/callback/:id" || route === "/verify-email";
}

/**
 * Refusals that are the person's own doing, or the product working as
 * designed: they are counted, since a spike in any of them is worth a
 * chart, but they do not open error tracking issues. A wrong password
 * is not a fault of the server, and an unconfirmed address is the
 * state every new hosted account is in until the mail is clicked.
 * Everything else (a provider that is not configured, a state that
 * would not verify, a code the provider would not exchange, a 500)
 * is a fault, and reaches error tracking.
 */
const EXPECTED_REFUSALS = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_EMAIL",
  "INVALID_PASSWORD",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "TOKEN_EXPIRED",
  "INVALID_TOKEN",
  "access_denied",
]);

/**
 * What the endpoint that just ran means for sign in or sign up, or
 * null when it means nothing (any other route, a session refresh, a
 * social start that is on its way to the provider and has decided
 * nothing yet, the account-link flow).
 */
export function describeAuthEvent(ctx: AuthHookContext): AuthEvent | null {
  const route = ctx.path ?? "";
  const flow: AuthFlow | null = route.startsWith("/sign-up/") ? "sign up" : isSignInRoute(route) ? "sign in" : null;
  if (!flow) return null;
  const method = methodFor(ctx);

  const session = ctx.context.newSession;
  if (session) {
    // A sign up that also signed the person in (a deployment without
    // the verification gate) is counted once, by its user row.
    if (flow === "sign up") return null;
    return { flow, outcome: "succeeded", userId: session.user.id, properties: { method, route } };
  }

  const refusal = reportsRefusals(route) ? refusalFrom(ctx.context.returned) : null;
  if (refusal) {
    // The callback with a session already in hand is the account-link
    // flow (Settings, connect GitHub), and its refusals are not failed
    // sign ins. A signed-in person signing in again loses a refusal
    // here, which is rare enough to accept over mislabelling every
    // link problem as a sign in problem.
    if (route === "/callback/:id" && holdsSession(ctx)) return null;
    return { flow, outcome: "failed", properties: { method, route, ...refusal } };
  }

  // The social start only sends the browser to the provider. Counted
  // as a start so a provider that never sends anyone back (a private
  // GitHub App answers outsiders with a 404 on its own site) shows up
  // as starts with no outcome.
  if (route === "/sign-in/social" && field(ctx.context.returned, "redirect") === true) {
    return { flow, outcome: "started", properties: { method, route } };
  }
  return null;
}

/**
 * How the person signed in or up. Provider ids are checked against the
 * configured providers: the callback path and the social start body
 * are both caller-supplied, and an unchecked value would let anyone
 * mint a new property value, and a new error tracking issue, per
 * request.
 */
export function methodFor(ctx: AuthHookContext | null | undefined): string {
  const route = ctx?.path ?? "";
  if (route === "/callback/:id") return knownProvider(ctx, field(ctx?.params, "id"));
  if (route === "/sign-in/social") return knownProvider(ctx, field(ctx?.body, "provider"));
  if (route === "/device/token") return "device";
  if (route === "/verify-email" || route.endsWith("/email")) return "email";
  return route.split("/").filter(Boolean).pop() ?? "unknown";
}

function knownProvider(ctx: AuthHookContext | null | undefined, id: unknown): string {
  const providers = ctx?.context.socialProviders ?? [];
  return typeof id === "string" && providers.some((provider) => provider.id === id) ? id : "unknown";
}

/**
 * The refusal an endpoint threw, if it threw one. better-auth answers
 * a JSON route with an APIError carrying a code, and a browser route
 * (the callback, verify-email) with a redirect, since there is nobody
 * mid-navigation to hand a status to: a refusal there is a redirect
 * whose location carries `error`. The last `error` in the query is
 * the one better-auth appended; the page it appended it to may have
 * carried one of its own.
 */
function refusalFrom(returned: unknown): { status: number; code: string } | null {
  if (!isApiError(returned)) return null;
  const status = returned.statusCode;
  if (status >= 300 && status < 400) {
    const location = locationOf(returned.headers);
    const code = location ? new URL(location, "http://localhost").searchParams.getAll("error").pop() : undefined;
    return code ? { status, code: safeCode(code) } : null;
  }
  return { status, code: safeCode(field(returned.body, "code") ?? `http_${status}`) };
}

interface ApiErrorLike {
  statusCode: number;
  body?: unknown;
  headers?: unknown;
}

function isApiError(value: unknown): value is ApiErrorLike {
  return typeof value === "object" && value !== null && "status" in value && typeof (value as unknown as ApiErrorLike).statusCode === "number";
}

function locationOf(headers: unknown): string | null {
  if (headers instanceof Headers) return headers.get("location");
  const value = field(headers, "location") ?? field(headers, "Location");
  return typeof value === "string" ? value : null;
}

/**
 * Error codes are property values and issue fingerprints, so they are
 * held to the alphabet better-auth's own codes use. A provider's
 * `error` parameter is forwarded by better-auth verbatim, and this is
 * where anything else it might carry stops.
 */
function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "other";
}

function holdsSession(ctx: AuthHookContext): boolean {
  const name = ctx.context.authCookies?.sessionToken.name;
  const cookie = ctx.headers?.get("cookie") ?? "";
  return Boolean(name) && cookie.split(";").some((part) => part.trim().startsWith(`${name}=`));
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * The error that reaches error tracking for a failure. Its own class
 * so the issue list reads "AuthFailureError" rather than "Error", and
 * a message built from the stable parts so occurrences of one cause
 * read alike.
 */
export class AuthFailureError extends Error {
  constructor(event: AuthEvent) {
    super(`${authEventName(event)}: ${event.properties.code ?? "unknown"} (${event.properties.method})`);
    this.name = "AuthFailureError";
  }
}

export function reportAuthEvent(analytics: Analytics, event: AuthEvent): void {
  analytics.capture({ event: authEventName(event), userId: event.userId ?? null, properties: event.properties });
  if (event.outcome !== "failed" || EXPECTED_REFUSALS.has(event.properties.code ?? "")) return;
  analytics.captureException(new AuthFailureError(event), null, null, {
    ...event.properties,
    // One issue per cause. Without this the grouping would fall back to
    // the stack, which is the same hook for every failure, so a broken
    // provider and an expired state would land in one issue.
    $exception_fingerprint: `${authEventName(event)}:${event.properties.method}:${event.properties.code}`,
  });
}

/**
 * The after hook body. Reporting never changes the response: whatever
 * the report does with the event, an error in it is logged and
 * better-auth's answer goes out as it was.
 */
export function authEventHook(onEvent: (event: AuthEvent) => void): (ctx: AuthHookContext) => void {
  return (ctx) => {
    try {
      const event = describeAuthEvent(ctx);
      if (event) onEvent(event);
    } catch (err) {
      console.warn("could not report an auth event:", err);
    }
  };
}
