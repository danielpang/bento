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

  /** Max agent runs executing at once, across all features. */
  /** A runner-claimed run with no report for this long is requeued. */
  BENTO_RUNNER_CLAIM_TIMEOUT_MIN: z.coerce.number().int().positive().default(45),
  BENTO_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().max(64).default(4),

  /** Required in multi mode. Generate with: openssl rand -hex 32 */
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().default("http://localhost:4400"),
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

  /** GitHub App credentials. Without these, PR based gates stay pending. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/).optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(withoutEmpty(source));
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
