import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { TokenBuckets } from "../mcp/rate-limit.js";

/**
 * Installs and updates of the Mac app, reported by the app itself.
 *
 * The app is not signed in when it reports, and in local mode it never
 * signs in to this server at all, so the route is public. Its
 * identity is a random install id the app keeps in its own profile:
 * the event is counted per install and makes no person profile. Local
 * Bento's server still never sends anything (`posthogApiKey`); this is
 * the app telling hosted Bento it exists, the way the install script's
 * download is counted on usebento.ai.
 *
 * Public, so it is held to a closed vocabulary (two event names,
 * versions and an architecture that match a pattern) and metered by
 * caller. A server with no PostHog key accepts and drops, because the
 * app cannot do anything differently about it.
 */

export const DESKTOP_EVENTS = { installed: "mac app installed", updated: "mac app updated" } as const;

const version = z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/);

export const desktopEventBody = z.object({
  event: z.enum(["installed", "updated"]),
  install_id: z.string().uuid(),
  version,
  /** The version this install reported before, on an update. "unknown" for an install from before the app reported. */
  previous_version: version.optional(),
  arch: z.enum(["arm64", "x64"]),
  os_version: version.optional(),
});

/** A few reports an hour per caller is plenty: one per launch that found a new version. */
const PER_CALLER = { capacity: 20, refillPerMs: 20 / 3_600_000 };

export function desktopEventRoutes(ctx: AppContext) {
  const callers = new TokenBuckets(PER_CALLER);
  return new Hono().post("/", async (c) => {
    // The first hop of the forwarded chain, as the invitation preview
    // meters it. A deployment with no proxy in front has no caller to
    // tell apart, and is not metered.
    const caller = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (caller && !callers.take(caller)) return c.json({ error: "too many requests" }, 429);

    const parsed = desktopEventBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid event" }, 400);
    const body = parsed.data;

    ctx.analytics?.capture({
      event: DESKTOP_EVENTS[body.event],
      distinctId: `desktop:${body.install_id}`,
      properties: {
        install_id: body.install_id,
        app_version: body.version,
        arch: body.arch,
        ...(body.previous_version ? { previous_version: body.previous_version } : {}),
        ...(body.os_version ? { os_version: body.os_version } : {}),
        $os: "Mac OS X",
      },
    });
    return c.body(null, 204);
  });
}
