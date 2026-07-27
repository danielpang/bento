import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ping } from "@bento/db";
import type { AppContext } from "./context.js";
import { actorMiddleware } from "./middleware/actor.js";
import { tenantMiddleware } from "./middleware/tenant.js";
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
import { member } from "@bento/db";
import { githubRoutes } from "./routes/github.js";

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
      return auth.handler(c.req.raw);
    });
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  }

  if (extras.cloudRoutes) app.route("/api/billing", extras.cloudRoutes);

  // Webhooks authenticate by signature, not by session.
  app.route("/api/webhooks", webhookRoutes(ctx));

  // The model catalog is the same for everyone and carries no tenant
  // data, so it sits outside the authenticated routes.
  app.route("/api/catalog", catalogRoutes());

  const api = new Hono()
    .use("*", actorMiddleware(ctx))
    .use("*", tenantMiddleware(ctx))
    .route("/projects", projectRoutes(ctx))
    .route("/board", boardEventRoutes(ctx))
    .route("/features", featureRoutes(ctx))
    .route("/profiles", profileRoutes(ctx))
    .route("/stages", stageRoutes(ctx))
    .route("/runs", runRoutes(ctx))
    .route("/runner", runnerRoutes(ctx))
    .route("/secrets", secretRoutes(ctx))
    .route("/github", githubRoutes(ctx))
    .route("/team", teamRoutes(ctx))
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
