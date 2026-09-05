import type { Analytics } from "./analytics.js";
import type { Auth } from "./auth.js";

/**
 * Sign in and sign up outcomes, reported to PostHog.
 *
 * better-auth owns these routes. It answers the JSON ones with a
 * session or a refusal, and the OAuth callback with a redirect, to the
 * board on success or to somewhere carrying an `error` code when not.
 * None of that is an exception, so until this existed a broken sign in
 * left a log line on the machine and nothing anywhere else: the
 * private GitHub App that answered every outside user with a 404 was
 * found by a user, not by a chart. Successes are reported as well as
 * failures, because a failure count only means something next to the
 * attempts, and a sign in that worked belongs on the person's timeline.
 *
 * Every outcome is one product event, named by flow and result and
 * carrying the method, stage, status, and on a failure the code. A
 * failure is also one error tracking occurrence, grouped by that same
 * code, so a new kind of failure shows up as a new issue rather than as
 * a bump in an old one.
 *
 * A success is attributed to the user it signed in. A failure has no
 * user, so it counts against the server rather than a person, and no
 * address or password ever rides along: the message is better-auth's
 * own generic wording.
 */

export type AuthEventName = "sign in succeeded" | "sign in failed" | "sign up succeeded" | "sign up failed";

export interface AuthEvent {
  event: AuthEventName;
  /** The user a success signed in, when the response says who. Never set on a failure. */
  userId?: string;
  properties: {
    /** "email", or the social provider id. */
    method: string;
    /** "request" for the JSON routes, "callback" for the return from a provider. */
    stage: "request" | "callback";
    /** The auth route, relative to the auth base path. */
    route: string;
    status: number;
    /** On a failure: better-auth's error code, or the `error` query parameter on a callback redirect. */
    code?: string;
    message?: string;
  };
}

/** Where better-auth is mounted; see app.ts and the basePath in auth.ts. */
const BASE_PATH = "/api/auth/";

interface Attempt {
  flow: "sign in" | "sign up";
  stage: "request" | "callback";
  route: string;
  /** Known from the route alone, or read from the request body for a social sign in. */
  method: string | null;
  /**
   * Whether a success here means someone is now signed in. The social
   * start only sends the browser away to the provider; its callback is
   * what decides. A refusal at any step is still a failure.
   */
  decides: boolean;
}

/**
 * Which sign in or sign up attempt a request is, or null for every
 * other auth route. Only the doors are watched: a missing session on
 * get-session is not a failed sign in, and reporting it would drown the
 * chart in every page load by someone signed out.
 */
export function classifyAuthRequest(method: string, url: string): Attempt | null {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(BASE_PATH)) return null;
  const route = pathname.slice(BASE_PATH.length);
  const [head, tail] = route.split("/");
  if (!tail) return null;

  if (method === "POST" && (head === "sign-in" || head === "sign-up")) {
    // The social start names its provider in the body, not the path.
    // Only the email routes finish here; anything else (a social start,
    // a plugin's link or code) sends the person somewhere else first.
    return {
      flow: head === "sign-in" ? "sign in" : "sign up",
      stage: "request",
      route,
      method: tail === "social" ? null : tail,
      decides: tail === "email",
    };
  }
  // GET only: a provider that POSTs its callback is answered with a
  // redirect to the GET form carrying the same parameters, and that
  // request is the one that decides. A first sign in through a provider
  // is a sign up underneath, but the callback does not say so; the
  // "user signed up" event from the database hook counts those.
  if (method === "GET" && head === "callback") {
    return { flow: "sign in", stage: "callback", route, method: tail, decides: true };
  }
  return null;
}

/**
 * What a response to an attempt means, or null when it is neither an
 * outcome (the social start succeeded in sending the browser away).
 *
 * The JSON routes answer with a status and, on success, the user. The
 * callback answers by redirecting: somewhere with `error` in the query
 * on a refusal, because the browser is mid-navigation and there is
 * nobody to hand a status to, and to the requested page otherwise, with
 * the session in a cookie that `userFromResponse` can read back.
 */
export async function describeAuthEvent(
  attempt: Attempt,
  response: Response,
  requestUrl: string,
  body: unknown,
  userFromResponse?: (response: Response) => Promise<string | null>,
): Promise<AuthEvent | null> {
  const method = attempt.method ?? providerFrom(body) ?? "unknown";
  const base = { method, stage: attempt.stage, route: attempt.route, status: response.status };
  const failed = (code: string, message?: string): AuthEvent => ({
    event: `${attempt.flow} failed`,
    properties: { ...base, code, ...(message ? { message } : {}) },
  });
  const succeeded = (userId: string | null): AuthEvent => ({
    event: `${attempt.flow} succeeded`,
    ...(userId ? { userId } : {}),
    properties: base,
  });

  if (attempt.stage === "callback" && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return null;
    const params = new URL(location, requestUrl).searchParams;
    const code = params.get("error");
    if (code) return failed(code, params.get("error_description") ?? undefined);
    return succeeded((await userFromResponse?.(response)) ?? null);
  }

  if (response.status >= 400) {
    const refusal = await readJson(response.clone());
    return failed(stringField(refusal, "code") ?? `http_${response.status}`, stringField(refusal, "message"));
  }
  if (response.status >= 300 || !attempt.decides) return null;

  const outcome = await readJson(response.clone());
  const user = outcome && typeof outcome === "object" ? (outcome as Record<string, unknown>).user : undefined;
  return succeeded(stringField(user, "id") ?? (await userFromResponse?.(response)) ?? null);
}

/**
 * The error that reaches error tracking for a failure. Its own class
 * so the issue list reads "AuthFailureError" rather than "Error", and
 * a message built from the stable parts so occurrences of one cause
 * read alike.
 */
export class AuthFailureError extends Error {
  constructor(event: AuthEvent) {
    super(`${event.event}: ${event.properties.code ?? "unknown"} (${event.properties.method})`);
    this.name = "AuthFailureError";
  }
}

export function reportAuthEvent(analytics: Analytics, event: AuthEvent): void {
  analytics.capture({ event: event.event, userId: event.userId ?? null, properties: event.properties });
  if (!event.event.endsWith("failed")) return;
  analytics.captureException(new AuthFailureError(event), null, null, {
    ...event.properties,
    // One issue per cause. Without this the grouping would fall back to
    // the stack, which is the same wrapper for every failure, so a wrong
    // password and a broken provider would land in one issue.
    $exception_fingerprint: `${event.event}:${event.properties.method}:${event.properties.code}`,
  });
}

/**
 * Wraps the auth handler so the sign in and sign up routes report their
 * outcomes to PostHog. Reporting never changes the response: a failure
 * to report is logged and the caller gets exactly what better-auth
 * answered. The analytics client is looked up per request rather than
 * captured, so a deployment without PostHog pays only the route check.
 */
export function reportAuthEvents(
  analytics: () => Analytics | null | undefined,
  handler: (request: Request) => Promise<Response>,
  options: {
    /** Who a successful response signed in, when the body does not say. */
    userFromResponse?: (response: Response) => Promise<string | null>;
  } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const attempt = classifyAuthRequest(request.method, request.url);
    const sink = attempt ? analytics() : null;
    if (!attempt || !sink) return handler(request);

    // Read from a clone, before the handler consumes the body. Only a
    // social sign in needs it, for the provider name.
    const body = attempt.method === null ? readJson(request.clone()) : Promise.resolve(null);
    const response = await handler(request);
    try {
      const event = await describeAuthEvent(attempt, response, request.url, await body, options.userFromResponse);
      if (event) reportAuthEvent(sink, event);
    } catch (err) {
      console.warn("could not report an auth event:", err);
    }
    return response;
  };
}

/**
 * Reads the user out of the session a response just set, for the OAuth
 * callback, whose redirect names nobody. The cookies better-auth set
 * are handed straight back to it as a request would carry them. One
 * session lookup per social sign in, which is rare enough to afford.
 */
export function userFromSessionCookie(auth: Pick<Auth, "api">): (response: Response) => Promise<string | null> {
  return async (response) => {
    const cookie = response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0]?.trim() ?? "")
      .filter(Boolean)
      .join("; ");
    if (!cookie) return null;
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.id ?? null;
  };
}

async function readJson(source: Request | Response): Promise<unknown> {
  try {
    return await source.json();
  } catch {
    return null;
  }
}

function providerFrom(body: unknown): string | null {
  return stringField(body, "provider") ?? stringField(body, "providerId") ?? null;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field ? field : undefined;
}
