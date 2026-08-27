import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ping } from "@bento/db";
import type { AppContext } from "./context.js";
import { activeOrg, actorMiddleware, maybeActor } from "./middleware/actor.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { boardEventRoutes, runRoutes } from "./routes/runs.js";
import { featureRoutes } from "./routes/features.js";
import { profileRoutes } from "./routes/profiles.js";
import { projectRoutes } from "./routes/projects.js";
import { runnerRoutes } from "./routes/runner.js";
import { secretRoutes } from "./routes/secrets.js";
import { settingsRoutes } from "./routes/settings.js";
import { teamRoutes } from "./routes/team.js";
import { stageRoutes } from "./routes/stages.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { catalogRoutes } from "./routes/catalog.js";
import { and, eq } from "drizzle-orm";
import { invitation, member } from "@bento/db";
import { invitationPreviewRoutes } from "./routes/invitations.js";
import { githubRoutes } from "./routes/github.js";
import { linearRoutes } from "./routes/linear.js";
import { slackRoutes } from "./routes/slack.js";
import { contactRoutes } from "./routes/contact.js";
import { flagRoutes } from "./routes/flags.js";

export interface AppExtras {
  /**
   * Routes supplied by the optional cloud module, mounted under
   * /api/billing. They authenticate through helpers the loader hands
   * the module, not through this app's tenant middleware: billing
   * tables are not tenant rows.
   */
  cloudRoutes?: Hono;
}

export function createApp(ctx: AppContext, extras: AppExtras = {}) {
  const app = new Hono();

  /**
   * The last stop for an error no route caught. An HTTPException is a
   * refusal somebody wrote on purpose and keeps its own response;
   * everything else is a bug, so it goes to error tracking with its
   * stack trace and the request that provoked it, and the caller gets
   * the same JSON error shape every route already speaks.
   *
   * The exception check is duck-typed the way Hono's own default
   * handler does it, not instanceof: hono is a peer dependency of the
   * middleware packages, and an HTTPException thrown by a second
   * resolved copy must not have its deliberate 401 rewritten as a 500.
   */
  app.onError((err, c) => {
    const refusal = err as { getResponse?: () => Response };
    if (typeof refusal.getResponse === "function") {
      const res = refusal.getResponse();
      // The cast bridges Node's two ReadableStream declarations, which
      // disagree about an optional field; the value is the same stream.
      return c.newResponse(res.body as unknown as ReadableStream | null, res);
    }
    ctx.analytics?.captureException(err, maybeActor(c), activeOrg(c), {
      path: c.req.path,
      method: c.req.method,
    });
    console.error(`unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal server error" }, 500);
  });

  // CORS must be registered before the routes it covers. set-auth-token
  // has to be exposed or browsers silently drop the bearer token.
  if (ctx.env.BENTO_MODE === "multi") {
    app.use(
      "/api/*",
      cors({
        origin: ctx.env.BENTO_TRUSTED_ORIGINS,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        exposeHeaders: ["Content-Length", "set-auth-token"],
        credentials: true,
        maxAge: 600,
      }),
    );
  }

  app.get("/api/health", async (c) => {
    try {
      await ping(ctx.db);
      return c.json({
        ok: true,
        mode: ctx.env.BENTO_MODE,
        driver: ctx.driver.provider,
        // Which social logins are actually configured, so the sign-in
        // page offers real buttons rather than ones that can only 404.
        social: {
          github: Boolean(ctx.env.GITHUB_CLIENT_ID && ctx.env.GITHUB_CLIENT_SECRET),
          google: Boolean(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET),
        },
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 503);
    }
  });

  // better-auth owns sign in, social login, and the device flow.
  if (ctx.auth) {
    const auth = ctx.auth;
    /**
     * The one auth endpoint with a plan limit on it. better-auth owns
     * invitation creation, so the check happens in front of it.
     *
     * The organization is only ever taken from a membership this
     * caller actually holds. Trusting the body's organizationId meant
     * anyone could aim the check at another tenant and read its plan
     * and headcount out of the refusal, before better-auth had
     * authorized anything: the probe this repository answers with 404
     * everywhere else. An id that names something else is left to
     * better-auth to refuse, which it does without saying whether the
     * organization exists.
     */
    app.post("/api/auth/organization/invite-member", async (c) => {
      if (ctx.entitlements) {
        const body = (await c.req.raw.clone().json().catch(() => null)) as { organizationId?: string } | null;
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        const activeOrganizationId = session?.session.activeOrganizationId ?? null;
        const wanted = body?.organizationId ?? activeOrganizationId;
        if (session && wanted) {
          const [membership] = await ctx.db
            .select({ id: member.id })
            .from(member)
            .where(and(eq(member.organizationId, wanted), eq(member.userId, session.user.id)))
            .limit(1);
          if (membership) {
            const refusal = await ctx.entitlements.canAddMember(wanted);
            // `message` as well as `error`: better-auth clients read
            // the former, and a limit nobody is told about reads as a
            // broken button.
            if (refusal) return c.json({ message: refusal.reason, error: refusal.reason, code: "PLAN_LIMIT" }, 402);
          }
        }
      }
      return handleAuth(c);
    });
    app.on(["GET", "POST"], "/api/auth/*", (c) => handleAuth(c));

    /**
     * better-auth's own handler, plus one announcement.
     *
     * A deployment that bills per seat has to hear about a headcount
     * that moved, and better-auth owns every route that moves it.
     *
     * The organization is resolved before the handler runs because two
     * of these routes carry only an invitation id. better-auth marks an
     * invitation rejected or cancelled rather than deleting it, so the
     * row would still be readable afterwards, but reading it first
     * keeps this from depending on that.
     */
    async function handleAuth(c: { req: { url: string; raw: Request } }): Promise<Response> {
      const announce = ctx.entitlements?.onMembershipChanged;
      const action = membershipAction(new URL(c.req.url).pathname);
      if (!announce || !action) return auth.handler(c.req.raw);

      const body = (await c.req.raw.clone().json().catch(() => null)) as
        | { organizationId?: string; invitationId?: string }
        | null;
      const organizationId = await organizationForAction(c, body);
      const response = await auth.handler(c.req.raw);
      // Only a change that happened. A refused invitation moves no
      // seat, and billing for one would be charging for the error.
      if (organizationId && response.ok) {
        void announce(organizationId).catch((err: unknown) => {
          // The membership change already succeeded and the user has
          // been told so. A deployment that cannot reach its billing
          // provider reconciles later; failing the request here would
          // undo nothing and confuse everyone.
          console.warn(`membership change announcement failed for ${organizationId}:`, err);
        });
      }
      return response;
    }

    /**
     * Which organization a membership route is about, before it runs.
     *
     * The body's organization id is checked against a membership this
     * caller actually holds, the same way the invite-member route above
     * does it and for the same reason: the discipline in this file is
     * that an id from a request body is a claim, not a fact. Nothing
     * here is exploitable today, since better-auth authorizes the
     * action itself and the announcement only fires when it succeeded.
     * But resolving the wrong organization would sync the wrong team's
     * seats, and that is a rule worth keeping rather than an assumption
     * about somebody else's library worth relying on.
     */
    async function organizationForAction(
      c: { req: { url: string; raw: Request } },
      body: { organizationId?: string; invitationId?: string } | null,
    ): Promise<string | null> {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return null;

      const claimed = body?.organizationId ?? null;
      if (claimed) {
        const [membership] = await ctx.db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, claimed), eq(member.userId, session.user.id)))
          .limit(1);
        // A leave request is the one case where the membership may
        // already be gone by the time this runs; the session's own
        // active organization then answers for it below.
        if (membership) return claimed;
      }

      if (body?.invitationId) {
        const [row] = await ctx.db
          .select({ organizationId: invitation.organizationId })
          .from(invitation)
          .where(eq(invitation.id, body.invitationId))
          .limit(1);
        if (row) return row.organizationId;
      }
      return session.session.activeOrganizationId ?? null;
    }
  }

  if (extras.cloudRoutes) app.route("/api/billing", extras.cloudRoutes);

  // Webhooks authenticate by signature, not by session.
  app.route("/api/webhooks", webhookRoutes(ctx));

  // The model catalog is the same for everyone and carries no tenant
  // data, so it sits outside the authenticated routes.
  app.route("/api/catalog", catalogRoutes());

  // The invitation email's pre-session read: who was invited, which
  // team, and whether that address already has an account. Public on
  // purpose; the invitation id is the capability. Mounted in every
  // mode so the page's contract holds everywhere: local mode has no
  // invitation rows, so every id answers 404 there.
  app.route("/api/invitation-preview", invitationPreviewRoutes(ctx));

  /**
   * Permanent feature flags. Evaluation waits on PostHog, so this sits
   * outside the tenant transaction: holding a pooled connection for
   * that round trip is the same class of problem the SSE streams are
   * excluded for. Actor is the whole check; there is no tenant row.
   */
  app.route("/api/flags", flagRoutes(ctx));

  const api = new Hono()
    .use("*", actorMiddleware(ctx))
    .use("*", tenantMiddleware(ctx))
    .route("/projects", projectRoutes(ctx))
    .route("/board", boardEventRoutes(ctx))
    .route("/features", featureRoutes(ctx))
    .route("/artifacts", artifactRoutes(ctx))
    .route("/profiles", profileRoutes(ctx))
    .route("/stages", stageRoutes(ctx))
    .route("/runs", runRoutes(ctx))
    .route("/runner", runnerRoutes(ctx))
    .route("/secrets", secretRoutes(ctx))
    .route("/github", githubRoutes(ctx))
    .route("/linear", linearRoutes(ctx))
    .route("/slack", slackRoutes(ctx))
    .route("/team", teamRoutes(ctx))
    .route("/contact", contactRoutes(ctx))
    .route("/settings", settingsRoutes(ctx));

  app.route("/api", api);

  /**
   * The web console is served from the same origin as the API, so the
   * session cookie, the OAuth callbacks, the /device page the terminal
   * login sends people to, and the /accept-invitation link in invitation
   * email all work with no CORS or cross-site cookie configuration.
   *
   * Unset in local development, where Vite serves the app and proxies
   * /api here instead.
   */
  if (ctx.env.BENTO_WEB_DIR) {
    const webDir = ctx.env.BENTO_WEB_DIR;
    // Hashed filenames, so assets can be cached indefinitely.
    app.use(
      "/assets/*",
      serveStatic({
        root: webDir,
        onFound: (_path, c) => c.header("cache-control", "public, max-age=31536000, immutable"),
      }),
    );
    /**
     * Files that sit at the root of the build: the favicons and the
     * touch icon. Without this they fell through to the shell below and
     * every browser was handed index.html when it asked for
     * /favicon.ico, which is a 200 that renders as a broken icon rather
     * than an error anybody would notice.
     *
     * A miss calls next(), so client routes still reach the shell. The
     * cache is short because these names carry no hash: a new icon has
     * to be able to replace the old one.
     */
    app.use(
      "*",
      serveStatic({
        root: webDir,
        onFound: (_path, c) => c.header("cache-control", "public, max-age=3600"),
      }),
    );
    // Every other non-API path is a client route: serve the shell and
    // let the app decide, which is what makes /device and
    // /accept-invitation survive a hard refresh.
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      const index = await readFile(path.join(webDir, "index.html"), "utf8").catch(() => null);
      if (index === null) return next();
      return c.html(index);
    });
  }

  return app;
}

export type AppType = ReturnType<typeof createApp>;

/**
 * The better-auth organization routes that change how many people an
 * organization holds, or null for everything else.
 *
 * Invitations count. A deployment that bills per seat counts members
 * plus invitations still open, so that an invitation reserves the seat
 * it is about to occupy: otherwise a team could hold twenty pending
 * invitations, pay for two, and have the bill jump the day everybody
 * happened to accept.
 *
 * accept-invitation is here even though it is net zero, one invitation
 * becoming one member. It costs a count that usually matches and does
 * nothing, and it is the moment a deployment is most likely to want to
 * check its arithmetic.
 */
function membershipAction(pathname: string): string | null {
  const prefix = "/api/auth/organization/";
  if (!pathname.startsWith(prefix)) return null;
  const action = pathname.slice(prefix.length);
  return MEMBERSHIP_ACTIONS.has(action) ? action : null;
}

const MEMBERSHIP_ACTIONS = new Set([
  "invite-member",
  "accept-invitation",
  "reject-invitation",
  "cancel-invitation",
  "remove-member",
  "leave",
]);
