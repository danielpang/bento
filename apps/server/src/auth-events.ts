import type { Analytics } from "./analytics.js";

/**
 * Sign in and sign up outcomes, reported to PostHog from better-auth's
 * after hook. The hook sees the session an endpoint minted and what it
 * answered or threw, which is what decides an outcome: the OAuth
 * callback also serves the account-link flow (no session, not a sign
 * in), and a hosted duplicate sign up is answered like a real one, so
 * sign ups are counted from the user row in auth.ts instead.
 *
 * Successes are attributed to the user. Failures carry no user and no
 * request text beyond a checked error code.
 */

export type AuthFlow = "sign in" | "sign up";
export type AuthOutcome = "started" | "succeeded" | "failed";

export interface AuthEvent {
  flow: AuthFlow;
  outcome: AuthOutcome;
  /** Set on a success only. */
  userId?: string;
  properties: {
    /** "email", "device", or a configured social provider id. */
    method: string;
    /** better-auth's route template, such as "/callback/:id". */
    route: string;
    /** Failures only. */
    status?: number;
    code?: string;
  };
}

/** The PostHog event name, such as "sign in failed". */
export function authEventName(event: AuthEvent): string {
  return `${event.flow} ${event.outcome}`;
}

/** The slice of better-auth's endpoint context this reads. */
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
 * Routes where a minted session is a sign in. Session refreshes,
 * set-active organization, and update-user mint sessions too and are
 * not. Device token is the CLI sign in; verify-email is the first sign
 * in when confirmation is required.
 */
const SIGN_IN_ROUTES = new Set(["/callback/:id", "/verify-email", "/device/token"]);

function isSignInRoute(route: string): boolean {
  return route.startsWith("/sign-in/") || SIGN_IN_ROUTES.has(route);
}

/** Device token is excluded: the CLI polls it and hears "pending" until approval. */
function reportsRefusals(route: string): boolean {
  return route.startsWith("/sign-in/") || route.startsWith("/sign-up/") || route === "/callback/:id" || route === "/verify-email";
}

/** Counted, but not error tracking issues: the person's own doing, or the product as designed. */
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

/** What the endpoint that just ran means for sign in or sign up, or null. */
export function describeAuthEvent(ctx: AuthHookContext): AuthEvent | null {
  const route = ctx.path ?? "";
  const flow: AuthFlow | null = route.startsWith("/sign-up/") ? "sign up" : isSignInRoute(route) ? "sign in" : null;
  if (!flow) return null;
  const method = methodFor(ctx);

  const session = ctx.context.newSession;
  if (session) {
    // A sign up that also signed the person in is counted once, by its user row.
    if (flow === "sign up") return null;
    return { flow, outcome: "succeeded", userId: session.user.id, properties: { method, route } };
  }

  const refusal = reportsRefusals(route) ? refusalFrom(ctx.context.returned) : null;
  if (refusal) {
    // A callback with a session in hand is the account-link flow.
    if (route === "/callback/:id" && holdsSession(ctx)) return null;
    return { flow, outcome: "failed", properties: { method, route, ...refusal } };
  }

  // A start, so a provider that never sends anyone back shows up as starts with no outcome.
  if (route === "/sign-in/social" && field(ctx.context.returned, "redirect") === true) {
    return { flow, outcome: "started", properties: { method, route } };
  }
  return null;
}

/** How the person signed in. Provider ids are checked against the configured providers: they are caller-supplied. */
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
 * The refusal an endpoint threw. JSON routes throw an APIError with a
 * code; browser routes redirect with `error` in the query, and the last
 * one is the one better-auth appended.
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

/** Codes are property values and fingerprints, so they are held to better-auth's own alphabet. */
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

/** The error tracking entry for a failure, named by its stable parts. */
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
    // One issue per cause, not one per stack.
    $exception_fingerprint: `${authEventName(event)}:${event.properties.method}:${event.properties.code}`,
  });
}

/** The after hook body. A failing report is logged and never changes the response. */
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
