import type { MiddlewareHandler } from "hono";

/**
 * Two years, every subdomain, and opted in to the preload list.
 *
 * The old domain was on `.dev`, a TLD preloaded whole, so browsers
 * refused plaintext to it whatever this server said. `.ai` carries no
 * such promise. Fly's `force_https` still bounces port 80, but a
 * redirect is a round trip an attacker on the path gets to answer
 * first; this header is what removes that trip from every later visit.
 *
 * `includeSubDomains` is what covers the console from the apex, and
 * `preload` is the opt-in hstspreload.org looks for. Both are close to
 * irreversible: removal from the preload list takes months to reach
 * browsers, and until it does, a subdomain that cannot serve HTTPS
 * cannot be reached at all. Every host under the domain has to speak
 * TLS before this is submitted.
 */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

/**
 * Whether the browser's own hop was HTTPS.
 *
 * Fly terminates TLS and forwards plaintext, so the socket here says
 * nothing; `x-forwarded-proto` is the only witness. It carries a list
 * when more than one proxy is in front, and the client's hop is the
 * first entry.
 *
 * A server with no proxy at all is the other case: then the request
 * URL is the witness, and nothing has rewritten it.
 */
export function arrivedOverHttps(forwardedProto: string | undefined, url: string): boolean {
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * HSTS, on responses that reached the browser over TLS.
 *
 * The gate is not about browsers, which ignore this header over
 * plaintext by rule. It is about local mode, which binds 127.0.0.1 over
 * http: anyone who puts a TLS proxy in front of a laptop install would
 * otherwise pin two years of HTTPS onto `localhost`, and onto every
 * other project they serve from it, which `includeSubDomains` makes
 * worse rather than better.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (arrivedOverHttps(c.req.header("x-forwarded-proto"), c.req.url)) {
      c.header("strict-transport-security", HSTS_VALUE);
    }
  };
}
