import { serve } from "@hono/node-server";
import { createDb, createPool, poolMaxForRuns, runMigrations, runEvents } from "@bento/db";
import type { AgentEvent } from "@bento/core";
import { createAnalytics } from "./analytics.js";
import { createFeatureFlags } from "./feature-flags.js";
import { startLogExport } from "./log-export.js";
import { attachPgBus } from "./pg-bus.js";
import { WorktreeManager } from "@bento/sandbox";
import PgBoss from "pg-boss";
import { createApp } from "./app.js";
import { createArtifactStore } from "./artifact-store.js";
import { createAuth, type AuthHooks } from "./auth.js";
import { createMailer, noticeMessage, type NoticeEmailInput } from "./mail.js";
import { SecretBox } from "./secrets.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { member, user } from "@bento/db";
import { createDriver, createGitHubApp, ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv, posthogApiKey, type Env } from "./env.js";
import { registerJobs } from "./orchestrator/run-executor.js";
import { QUEUE_POLL_SECONDS } from "./orchestrator/queue.js";

export interface StartOptions {
  /** Overrides applied on top of the process environment. */
  env?: Partial<Record<keyof NodeJS.ProcessEnv, string>>;
  /** Apply pending migrations before serving. Embedded callers want this. */
  migrate?: boolean;
  /** Suppress the startup banner (the TUI draws its own chrome). */
  quiet?: boolean;
}

/**
 * How long after the sign up hook fires before its capture reads the
 * row back. The hook runs inside better-auth's transaction; by this
 * long after it, the sign up has committed or rolled back either way.
 */
const SIGNUP_CONFIRM_DELAY_MS = 1000;

export interface RunningServer {
  url: string;
  port: number;
  mode: Env["BENTO_MODE"];
  sandboxDriver: Env["BENTO_SANDBOX_DRIVER"];
  stop(): Promise<void>;
}

/**
 * Boots the full stack: database, queue, orchestrator, and HTTP API.
 *
 * Exported so the TUI can run everything in one process (`bento` with no
 * server flag) using exactly the same code path as a self-hosted or
 * hosted deployment. Port 0 asks the OS for a free port, which is what
 * the embedded case wants.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  // Kept for the cloud module, whose own variables (Stripe, the sales
  // inbox) are deliberately unknown to this schema.
  const rawEnv = { ...process.env, ...options.env } as NodeJS.ProcessEnv;
  const env = loadEnv(rawEnv);

  if (options.migrate) await runMigrations(env.DATABASE_URL);

  // Before anything logs: the export wraps console, so the earlier it
  // starts the more of the boot story PostHog gets to keep.
  const logExport = startLogExport(env);
  const analytics = createAnalytics(env);
  const featureFlags = createFeatureFlags(env);

  /**
   * Everything below can throw: pg-boss on an unreachable database,
   * the multi mode key check, a taken port. The lines above installed
   * process-global state (a wrapped console, exception listeners), and
   * the embedded TUI catches a failed boot and keeps running, so a
   * throw must take those installs back out on its way up.
   */
  try {
    const poolMax = poolMaxForRuns(env.BENTO_MAX_CONCURRENT_RUNS);
    const pool = createPool(env.DATABASE_URL, { max: poolMax });
    const db = createDb(pool);

    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: "pgboss",
      // Polling does not need one connection per worker. Enough that a
      // burst of completions is not queued behind the default 10.
      max: Math.min(poolMax, Math.max(10, Math.ceil(env.BENTO_MAX_CONCURRENT_RUNS / 2))),
      // Idle workers poll slowly so an idle database can be idle; see
      // orchestrator/queue.ts for why, and for the run workers' own pace.
      pollingIntervalSeconds: QUEUE_POLL_SECONDS,
    });
    boss.on("error", (err) => {
      console.error("pg-boss error:", err);
      analytics?.captureException(err, null, null, { source: "pg-boss" });
    });
    await boss.start();

    // Local mode has a single implicit user; multi mode uses better-auth.
    const userId = env.BENTO_MODE === "multi" ? "" : await ensureLocalUser(db);
    const mailer = createMailer(env);
    /**
     * Filled in by the cloud module below, if one loads. Auth is built
     * first because the loader needs it to answer "who is asking", so the
     * hook travels as a holder rather than as a value.
     */
    const authHooks: AuthHooks = {};
    if (analytics) {
      const posthog = analytics;
      authHooks.onUserSignedUp = (u) => {
        /**
         * better-auth's adapter runs its hooks inside the sign up's own
         * transaction, so the row this announces may still roll back (an
         * account insert failing later in the same sign up). The capture
         * writes real PII onto a person profile, which must not exist for
         * an account that never did: wait out the commit, then read the
         * row back on a pooled connection and count only what is really
         * there.
         */
        setTimeout(() => {
          void db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, u.id))
            .limit(1)
            .then(([row]) => {
              if (!row) return;
              posthog.capture({
                event: "user signed up",
                userId: u.id,
                properties: { $set: { email: u.email, name: u.name } },
              });
            })
            .catch((err: unknown) => {
              console.warn("could not record the sign up:", err);
              posthog.captureException(err, u.id, null, { source: "signup_capture" });
            });
        }, SIGNUP_CONFIRM_DELAY_MS).unref();
      };
    }
    const auth = createAuth(env, db, mailer, authHooks);

    if (env.BENTO_MODE === "multi" && !env.BENTO_SECRET_KEY) {
      throw new Error("BENTO_SECRET_KEY is required in multi mode. Generate one with: openssl rand -hex 32");
    }
    // Local mode has one trusted user and no tenant boundary, so a key
    // derived from the install is enough to keep credentials off disk in
    // plaintext. Hashed rather than concatenated: a short data directory
    // would otherwise produce a key below the minimum length and stop the
    // server from starting at all.
    const secretBox = new SecretBox(
      env.BENTO_SECRET_KEY ?? createHash("sha256").update(`bento-local:${env.BENTO_DATA_DIR}`).digest("hex"),
    );

    const artifacts = createArtifactStore(env);
    if (env.BENTO_MODE === "multi" && !artifacts) {
      console.warn(
        "No artifact bucket is configured, so agents' binary artifacts (screenshots, HTML previews) are not kept. Run `fly storage create`, or set BENTO_ARTIFACTS_BUCKET, _ENDPOINT, _ACCESS_KEY_ID, and _SECRET_ACCESS_KEY.",
      );
    }
    // Beside the artifact warning and at the same level, because it is
    // the same kind of news: an optional service a hosted deployment
    // probably wanted is off. Local installs and the TUI stay quiet;
    // measuring a laptop was never the point, and a leftover key must
    // not start sending.
    if (env.BENTO_MODE === "multi" && !posthogApiKey(env) && !options.quiet) {
      console.warn(
        "POSTHOG_API_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This warning stops appearing once POSTHOG_API_KEY is configured.",
      );
    }

    const ctx: AppContext = {
      env,
      db,
      pool,
      boss,
      bus: new EventBus(),
      driver: createDriver(env),
      worktrees: new WorktreeManager(env.BENTO_DATA_DIR),
      secretBox,
      artifacts,
      running: new Map(),
      liveInputs: new Map(),
      userId,
      draining: false,
    };
    const githubApp = createGitHubApp(env);
    if (githubApp) ctx.githubApp = githubApp;
    if (auth) ctx.auth = auth;
    if (analytics) ctx.analytics = analytics;
    ctx.featureFlags = featureFlags;

    await registerJobs(ctx);

    /**
     * Replicates bus events across server processes, so a viewer whose
     * SSE stream landed on one machine sees a run executing on another.
     * The load callback runs as the server, not a tenant: access was
     * already checked when the receiving stream subscribed, exactly as
     * it is for locally emitted events.
     */
    const pgBus = await attachPgBus({
      bus: ctx.bus,
      pool,
      connectionString: env.DATABASE_URL,
      loadRunEvent: async (runId, seq) => {
        const [row] = await db
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, runId), eq(runEvents.seq, seq)))
          .limit(1);
        return (row?.payload as AgentEvent | undefined) ?? null;
      },
    });

    /**
     * The deployment extension, when one is configured. Everything about
     * plans and billing lives in that module, not here: this loader hands
     * it the database, the mailer, and a way to answer "who is asking",
     * and takes back routes plus the entitlement checks. An open source
     * install never sets the variable and never runs any of this.
     */
    let cloudRoutes: import("hono").Hono | undefined;
    // Multi mode only, by construction: a local or self-hosted single
    // user install must never grow plans, limits, or billing routes,
    // even with the variable set. Everything the module adds hangs off
    // organizations, and local mode has none.
    if (env.BENTO_CLOUD_MODULE && env.BENTO_MODE !== "multi") {
      console.warn("BENTO_CLOUD_MODULE is set but this is not multi mode; ignoring it.");
    }
    if (env.BENTO_CLOUD_MODULE && env.BENTO_MODE === "multi") {
      const name = env.BENTO_CLOUD_MODULE;
      const specifier =
        name.startsWith(".") || name.startsWith("/") ? pathToFileURL(path.resolve(name)).href : name;
      const mod = (await import(specifier)) as {
        registerCloud?: (host: {
          db: typeof db;
          mailer: typeof mailer;
          notify(message: Omit<NoticeEmailInput, "appUrl">): Promise<void>;
          appUrl: string;
          rawEnv: Record<string, string | undefined>;
          identify(headers: Headers): Promise<{ userId: string; organizationId: string; role: string } | null>;
        }) => Promise<{
          routes?: import("hono").Hono;
          entitlements?: AppContext["entitlements"];
          onOrganizationDeleted?: (organizationId: string) => Promise<void>;
        }>;
      };
      if (typeof mod.registerCloud !== "function") {
        throw new Error(`BENTO_CLOUD_MODULE ${name} does not export registerCloud`);
      }
      const registered = await mod.registerCloud({
        db,
        mailer,
        /**
         * Mail in Bento's own envelope. The module supplies copy and
         * this wraps it in the layout every other email uses, so a
         * usage warning from the hosted plan does not arrive as a
         * plain text message from a product whose other mail is not.
         */
        notify: (message) =>
          mailer.send(noticeMessage({ ...message, appUrl: env.BETTER_AUTH_URL.replace(/\/$/, "") })),
        appUrl: env.BETTER_AUTH_URL,
        rawEnv,
        // Session and membership stay this server's job: the module gets
        // an answer, not access to the auth internals.
        identify: async (headers) => {
          if (!auth) return null;
          const session = await auth.api.getSession({ headers });
          const organizationId = session?.session.activeOrganizationId ?? null;
          if (!session || !organizationId) return null;
          const [row] = await db
            .select({ role: member.role })
            .from(member)
            .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
            .limit(1);
          return row ? { userId: session.user.id, organizationId, role: row.role } : null;
        },
      });
      if (registered.entitlements) ctx.entitlements = registered.entitlements;
      if (registered.routes) cloudRoutes = registered.routes;
      if (registered.onOrganizationDeleted) authHooks.onOrganizationDeleted = registered.onOrganizationDeleted;
      console.log(`cloud module loaded from ${name}`);
    }

    const app = createApp(ctx, { ...(cloudRoutes ? { cloudRoutes } : {}) });
    // Local mode binds loopback only; multi mode (hosted or self-hosted)
    // binds all interfaces.
    /**
     * Local mode binds loopback so a single user's server is not exposed
     * to the network. In a container that is loopback INSIDE the
     * container, which no published port can reach, so the address is
     * settable. Publishing it as 127.0.0.1:4400:4400 keeps the same
     * property one layer out: reachable from that machine, nowhere else.
     */
    const hostname = env.BENTO_HOST ?? (env.BENTO_MODE === "local" ? "127.0.0.1" : "0.0.0.0");

    const server = await new Promise<{ port: number; handle: ReturnType<typeof serve> }>((resolve) => {
      const handle = serve(
        { fetch: app.fetch, port: env.PORT, hostname },
        (info) => resolve({ port: info.port, handle }),
      );
    });

    if (!options.quiet) {
      console.log(
        `bento server listening on http://${hostname}:${server.port} (${env.BENTO_MODE} mode, ${env.BENTO_SANDBOX_DRIVER} sandboxes, ${env.BENTO_MAX_CONCURRENT_RUNS} run workers)`,
      );
      if (env.BENTO_MODE === "multi") console.log(`invitation mail: ${mailer.description}`);
    }

    return {
      url: `http://127.0.0.1:${server.port}`,
      port: server.port,
      mode: env.BENTO_MODE,
      sandboxDriver: env.BENTO_SANDBOX_DRIVER,
      async stop() {
        /**
         * First, before anything closes: run loops survive every await
         * below, and the replacement process may already be reattaching
         * to their runs. From here they consume their streams silently
         * and write nothing, so the successor is the transcript's only
         * writer.
         */
        ctx.draining = true;
        await new Promise<void>((resolve) => {
          /**
           * Stop accepting, then sever what is still open. An SSE stream
           * never ends on its own, so a close that waits for connections
           * to drain waits forever, and a deploy that gives up on it
           * becomes a hard kill with no goodbye. Severed viewers
           * reconnect and replay from their last seen event; severed
           * agent runs are what the next boot's reattach is for.
           */
          server.handle.close(() => resolve());
          (server.handle as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
        await boss.stop({ close: true, timeout: 2000 }).catch(() => {});
        await pgBus.stop().catch(() => {});
        // Flush before the pool closes: capture is fire and forget, so
        // whatever queued in the last seconds is only on this machine.
        await analytics?.shutdown().catch(() => {});
        await featureFlags.shutdown().catch(() => {});
        await logExport?.stop().catch(() => {});
        await pool.end().catch(() => {});
      },
    };
  } catch (err) {
    analytics?.captureException(err, null, null, { source: "boot" });
    await analytics?.shutdown().catch(() => {});
    await featureFlags.shutdown().catch(() => {});
    await logExport?.stop().catch(() => {});
    throw err;
  }
}
