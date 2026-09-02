import os from "node:os";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  BENTO_MODE: z.enum(["local", "multi"]).default("local"),
  /** 0 asks the OS for any free port, which embedded mode uses. */
  PORT: z.coerce.number().int().min(0).max(65535).default(4400),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5439/app"),
  /** Where worktrees and other server state live. */
  BENTO_DATA_DIR: z.string().default(path.join(os.homedir(), ".bento")),
  /** docker = isolated containers (default); local-process = no isolation, dev/test only. */
  BENTO_SANDBOX_DRIVER: z.enum(["docker", "local-process", "sprite"]).default("docker"),
  /** Required when BENTO_SANDBOX_DRIVER=sprite. */
  SPRITES_TOKEN: z.string().optional(),
  SPRITES_REGION: z.string().optional(),
  BENTO_SANDBOX_IMAGE: z.string().default("bento-sandbox:dev"),
  /** Forwarded into sandboxes for the agent adapters when set. */
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CURSOR_API_KEY: z.string().optional(),

  /**
   * How many agent runs this process drives at once. Not a plan limit:
   * sprites (or containers) do the work, and this is how many exec
   * sockets and keep-awake pings one Node process will hold. Local
   * installs default to 4 so a laptop is not asked to run a fleet.
   * Hosted Fly sets this higher in fly.toml.
   */
  BENTO_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4),
  /** A runner-claimed run with no report for this long is requeued. */
  BENTO_RUNNER_CLAIM_TIMEOUT_MIN: z.coerce.number().int().positive().default(45),
  /**
   * How long one agent run may execute before it is stopped, in
   * minutes. A backstop against runaway processes, not a pace
   * expectation: real agent sessions legitimately run for hours, the
   * way they do on the hosted agent products.
   */
  BENTO_RUN_TIMEOUT_MIN: z.coerce.number().int().positive().default(120),
  /**
   * After a live agent (pi, Claude Code) finishes a turn on a manual
   * stage, how long to keep the process open for another message, in
   * seconds. 0 closes stdin as soon as the queue is empty, which is
   * the old one-shot behaviour. Automatic stages and judge runs ignore
   * this: their gate has to run when the turn ends.
   */
  BENTO_LIVE_IDLE_SEC: z.coerce.number().int().min(0).default(90),

  /** Required in multi mode. Generate with: openssl rand -hex 32 */
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().default("http://localhost:4400"),

  /**
   * Base URL a sandbox uses to reach the MCP gateway. Defaults to
   * BETTER_AUTH_URL, which is right when the server is publicly
   * routable. Set it when sandboxes cannot reach that address: a Docker
   * driver on a localhost base rewrites the host to host.docker.internal
   * automatically, but a sprite fleet or a segregated gateway host
   * needs this pointed at a URL the sandbox can actually open.
   */
  BENTO_MCP_GATEWAY_URL: z.string().optional(),

  /**
   * Where the browsable MCP catalog is read from. Defaults to the
   * official public registry. Point it at a private registry to offer
   * an internal list instead, or set it to a URL that does not resolve
   * to hide the catalog and leave only the custom URL form.
   */
  BENTO_MCP_REGISTRY_URL: z.string().optional(),
  /** Origins allowed to call the API with credentials, comma separated. */
  BENTO_TRUSTED_ORIGINS: z
    .string()
    .default("http://localhost:4400,http://localhost:4401")
    .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean)),

  /**
   * A personal access token for pushing branches and opening pull
   * requests from stages with Create a pull request enabled, for
   * deployments without the GitHub App. Server-side only: it is never
   * part of an agent's environment.
   */
  GITHUB_TOKEN: z.string().optional(),

  /**
   * Path or module name of an optional deployment extension, loaded at
   * startup. This is how a hosted deployment adds plans and billing
   * without any of that living in this codebase: the module registers
   * routes under /api/billing and supplies the entitlement checks.
   */
  BENTO_CLOUD_MODULE: z.string().optional(),

  /**
   * A Docker network with no route out, for organizations that lock
   * their agents down. The egress rules belong to the network, so the
   * operator creates it; without this, an organization that asked to be
   * locked down is refused rather than quietly given open egress.
   */
  BENTO_SANDBOX_RESTRICTED_NETWORK: z.string().optional(),

  /**
   * Whether an address must be confirmed before an account can sign in.
   * Unset follows whether SMTP is configured, which keeps a laptop
   * install from locking itself out behind mail it cannot send.
   */
  /**
   * Brute force protection. On by default in multi mode; a test or a
   * closed internal deployment can turn it off deliberately.
   */
  BENTO_RATE_LIMIT: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),

  BENTO_REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),

  /** Social login (multi mode). Providers are enabled only when both halves are set. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  /**
   * Directory holding the built web console. When set, the server
   * serves it from the same origin as the API. Unset in development,
   * where Vite serves it and proxies /api here.
   */
  BENTO_WEB_DIR: z.string().optional(),

  /**
   * Encrypts organization secrets at rest. Required in multi mode;
   * local mode derives one from the data directory, since there is a
   * single trusted user and no tenant boundary to protect.
   */
  BENTO_SECRET_KEY: z.string().optional(),

  /**
   * Address to bind. Defaults to loopback in local mode and every
   * interface in multi mode; set it when the loopback the server can
   * see is not the one a client can reach, which is what running in a
   * container means.
   */
  BENTO_HOST: z.string().optional(),

  /**
   * Share the user's own agent logins with sandboxes, so a Claude,
   * Codex, or Cursor subscription works without a separate API key.
   * Local mode only, and ignored in multi mode: an operator's logins
   * must never reach a tenant's sandbox.
   */
  BENTO_SHARE_AGENT_AUTH: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),

  /**
   * SMTP. Without SMTP_HOST, invitation mail is written to the log
   * instead of sent, and the link can be passed along by hand.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Implicit TLS. Defaults to true on port 465, STARTTLS elsewhere. */
  SMTP_SECURE: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  BENTO_MAIL_FROM: z.string().default("Bento <no-reply@bento.local>"),

  /**
   * Where the in-app contact form delivers its mail. Without it the
   * form reports that contact is not configured rather than sending
   * feedback nowhere.
   */
  BENTO_CONTACT_EMAIL: z.string().optional(),

  /**
   * The S3-compatible bucket binary run artifacts (screenshots, HTML
   * previews) are stored in. All four must be set for the bucket to be
   * used. The BENTO_ARTIFACTS_* names win when both are present; the
   * plain AWS_* and BUCKET_NAME names below are what Fly's
   * `fly storage create` (Tigris) injects, so that path needs no
   * configuration at all. Without a bucket, local mode stores files
   * under BENTO_DATA_DIR and multi mode captures text artifacts only:
   * the machine's disk does not survive a deploy.
   */
  BENTO_ARTIFACTS_BUCKET: z.string().optional(),
  BENTO_ARTIFACTS_ENDPOINT: z.string().optional(),
  BENTO_ARTIFACTS_ACCESS_KEY_ID: z.string().optional(),
  BENTO_ARTIFACTS_SECRET_ACCESS_KEY: z.string().optional(),
  BENTO_ARTIFACTS_REGION: z.string().optional(),
  /** The names `fly storage create` sets. Read only as fallbacks for the above. */
  BUCKET_NAME: z.string().optional(),
  AWS_ENDPOINT_URL_S3: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),

  /**
   * PostHog: product analytics, error tracking, log export, and the
   * beta-testers feature flag. All four read the same project token.
   * The console also reads it from /api/health to capture browser
   * exceptions. Local mode never sends, even if a leftover key is in
   * the environment: a laptop is not a telemetry source. Multi mode
   * without a key also sends nothing, and the server says so once at
   * boot, because events silently missed are worse than a line of
   * noise. New product that is not ready for every signed-in user is
   * gated on `beta-testers`.
   */
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
  /**
   * Stamped as the `environment` property on every PostHog event,
   * exception, and log record, so one project can hold both
   * environments without dev noise polluting production dashboards.
   * Defaults to development: production is a claim a deployment makes
   * explicitly (each Fly config does), never one it drifts into. The
   * shared image sets nothing, because when it claimed production the
   * development app inherited that claim.
   */
  BENTO_ENVIRONMENT: z.enum(["development", "production"]).default("development"),

  /**
   * Fly sets both on every machine; absent anywhere else. Stamped onto
   * the run queue snapshot so two snapshots a minute read as two
   * machines rather than a doubled queue.
   */
  FLY_APP_NAME: z.string().optional(),
  FLY_MACHINE_ID: z.string().optional(),

  /** GitHub App credentials. Without these, PR based gates stay pending. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/).optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Slack app credentials. Without these, the Slack tab says the
   * integration is not configured rather than offering an install that
   * cannot finish.
   */
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(withoutEmpty(source));
}

/**
 * The project token when this process should talk to PostHog.
 *
 * Null in local mode, even if POSTHOG_API_KEY is set: people running
 * Bento on a laptop often have a leftover key from hosted work, and
 * that must not ship console errors or product events into the real
 * project. Null in multi mode when the key is missing or whitespace,
 * so a hosted deploy without PostHog configured also sends nothing.
 */
export function posthogApiKey(env: Env): string | null {
  if (env.BENTO_MODE !== "multi") return null;
  const key = env.POSTHOG_API_KEY?.trim();
  return key ? key : null;
}

/**
 * Drops variables set to an empty string, so they read as absent.
 *
 * `.env.example` ships optional keys with nothing after the `=`, and
 * anything that forwards an environment (docker compose, a CI runner)
 * passes those along as empty strings rather than omitting them. An
 * optional setting then arrives present-but-empty, and code that falls
 * back with `??` does not fall back: local mode refused to start
 * because it read `BENTO_SECRET_KEY=` as a key too short rather than
 * as no key at all.
 *
 * A variable someone deliberately set to empty means the same thing as
 * one they never set, so this loses nothing.
 */
function withoutEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== "") out[key] = value;
  }
  return out;
}
