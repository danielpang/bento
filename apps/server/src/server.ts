import { serve } from "@hono/node-server";
import { createDb, createPool, runMigrations } from "@bento/db";
import { WorktreeManager } from "@bento/sandbox";
import PgBoss from "pg-boss";
import { createApp } from "./app.js";
import { createAuth, type AuthHooks } from "./auth.js";
import { createMailer } from "./mail.js";
import { SecretBox } from "./secrets.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { member } from "@bento/db";
import { createDriver, createGitHubApp, ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv, type Env } from "./env.js";
import { registerJobs } from "./orchestrator/run-executor.js";

export interface StartOptions {
  /** Overrides applied on top of the process environment. */
  env?: Partial<Record<keyof NodeJS.ProcessEnv, string>>;
  /** Apply pending migrations before serving. Embedded callers want this. */
  migrate?: boolean;
  /** Suppress the startup banner (the TUI draws its own chrome). */
  quiet?: boolean;
}

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

  const pool = createPool(env.DATABASE_URL);
  const db = createDb(pool);

  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => console.error("pg-boss error:", err));
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

  const ctx: AppContext = {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    driver: createDriver(env),
    worktrees: new WorktreeManager(env.BENTO_DATA_DIR),
    secretBox,
    running: new Map(),
    liveInputs: new Map(),
    userId,
  };
  const githubApp = createGitHubApp(env);
  if (githubApp) ctx.githubApp = githubApp;
  if (auth) ctx.auth = auth;

  await registerJobs(ctx);

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
      `bento server listening on http://${hostname}:${server.port} (${env.BENTO_MODE} mode, ${env.BENTO_SANDBOX_DRIVER} sandboxes)`,
    );
    if (env.BENTO_MODE === "multi") console.log(`invitation mail: ${mailer.description}`);
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    mode: env.BENTO_MODE,
    sandboxDriver: env.BENTO_SANDBOX_DRIVER,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.handle.close((err) => err ? reject(err) : resolve());
      }).catch(() => {});
      await boss.stop({ close: true, timeout: 2000 }).catch(() => {});
      await pool.end().catch(() => {});
    },
  };
}
