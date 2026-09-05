import type { Analytics } from "./analytics.js";

/**
 * Sign in and sign up failures, reported to PostHog.
 *
 * better-auth owns these routes and answers a refusal with a JSON body
 * (email and password, or starting a social flow) or with a redirect
 * whose query carries an `error` code (the OAuth callback). Neither is
 * an exception, so until this existed a refusal left a log line on the
 * machine and nothing anywhere else: the private GitHub App that
 * answered every outside user with a 404 was found by a user, not by a
 * chart. This wraps the handler and turns each refusal into one product
 * event, counted by method and code, and one error tracking occurrence
 * grouped by that same code, so a new kind of failure shows up as a
 * new issue rather than as a bump in an old one.
 *
 * No address or password ever rides along. A failed attempt has no
 * user, so the event is counted against the server rather than a
 * person, and the message is better-auth's own generic wording.
 */

export type AuthFailureEvent = "sign in failed" | "sign up failed";

export interface AuthFailure {
  event: AuthFailureEvent;
  properties: {
    /** "email", or the social provider id. */
    method: string;
    /** "request" for the JSON routes, "callback" for the return from a provider. */
    stage: "request" | "callback";
    /** The auth route, relative to the auth base path. */
    route: string;
    status: number;
    /** better-auth's error code, or the `error` query parameter on a callback redirect. */
    code: string;
    message?: string;
  };
}

/** Where better-auth is mounted; see app.ts and the basePath in auth.ts. */
const BASE_PATH = "/api/auth/";

interface Attempt {
  event: AuthFailureEvent;
  stage: "request" | "callback";
  route: string;
  /** Known from the route alone, or read from the request body for a social sign in. */
  method: string | null;
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

  if (method === "POST" && head === "sign-in") {
    // The social start names its provider in the body, not the path.
    return { event: "sign in failed", stage: "request", route, method: tail === "social" ? null : tail };
  }
  if (method === "POST" && head === "sign-up") {
    return { event: "sign up failed", stage: "request", route, method: tail === "social" ? null : tail };
  }
  // GET only: a provider that POSTs its callback is answered with a
  // redirect to the GET form carrying the same parameters, and that
  // request is the one that decides.
  if (method === "GET" && head === "callback") {
    return { event: "sign in failed", stage: "callback", route, method: tail };
  }
  return null;
}

/**
 * Whether a response to an attempt is a refusal, and how to describe
 * it. The JSON routes refuse with a status; the callback refuses by
 * redirecting somewhere with `error` in the query, because the browser
 * is mid-navigation and there is nobody to hand a status to.
 */
export async function describeAuthFailure(
  attempt: Attempt,
  response: Response,
  requestUrl: string,
  body: unknown,
): Promise<AuthFailure | null> {
  const method = attempt.method ?? providerFrom(body) ?? "unknown";
  const base = { method, stage: attempt.stage, route: attempt.route, status: response.status };

  if (attempt.stage === "callback" && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return null;
    const params = new URL(location, requestUrl).searchParams;
    const code = params.get("error");
    if (!code) return null;
    const message = params.get("error_description") ?? undefined;
    return { event: attempt.event, properties: { ...base, code, ...(message ? { message } : {}) } };
  }

  if (response.status < 400) return null;
  const refusal = await readJson(response.clone());
  const code = stringField(refusal, "code") ?? `http_${response.status}`;
  const message = stringField(refusal, "message");
  return { event: attempt.event, properties: { ...base, code, ...(message ? { message } : {}) } };
}

/**
 * The error that reaches error tracking. Its own class so the issue
 * list reads "AuthFailureError" rather than "Error", and a message
 * built from the stable parts so occurrences of one cause read alike.
 */
export class AuthFailureError extends Error {
  constructor(failure: AuthFailure) {
    super(`${failure.event}: ${failure.properties.code} (${failure.properties.method})`);
    this.name = "AuthFailureError";
  }
}

export function reportAuthFailure(analytics: Analytics, failure: AuthFailure): void {
  analytics.capture({ event: failure.event, properties: failure.properties });
  analytics.captureException(new AuthFailureError(failure), null, null, {
    ...failure.properties,
    // One issue per cause. Without this the grouping would fall back to
    // the stack, which is the same wrapper for every failure, so a wrong
    // password and a broken provider would land in one issue.
    $exception_fingerprint: `${failure.event}:${failure.properties.method}:${failure.properties.code}`,
  });
}

/**
 * Wraps the auth handler so refusals on the sign in and sign up routes
 * reach PostHog. Reporting never changes the response: a failure to
 * report is logged and the caller gets exactly what better-auth
 * answered. The analytics client is looked up per request rather than
 * captured, so a deployment without PostHog pays only the route check.
 */
export function reportAuthFailures(
  analytics: () => Analytics | null | undefined,
  handler: (request: Request) => Promise<Response>,
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
      const failure = await describeAuthFailure(attempt, response, request.url, await body);
      if (failure) reportAuthFailure(sink, failure);
    } catch (err) {
      console.warn("could not report an auth failure:", err);
    }
    return response;
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
