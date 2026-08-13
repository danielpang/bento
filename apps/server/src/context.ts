import type { Db } from "@bento/db";
import { user } from "@bento/db";
import { GitHubApp } from "@bento/github";
import { DockerDriver, LocalProcessDriver, SpriteDriver, WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import type PgBoss from "pg-boss";
import type pg from "pg";
import type { ArtifactStore } from "./artifact-store.js";
import type { Auth } from "./auth.js";
import type { SecretBox } from "./secrets.js";
import { EventBus } from "./events.js";
import type { Env } from "./env.js";

export const LOCAL_USER_ID = "local-user";

export interface LiveInput {
  /** How the tool treats a mid-task message; shown to the user. */
  delivery: "steer" | "queue";
  /** False when the session just closed; callers fall back to queueing. */
  deliver(text: string): Promise<boolean>;
}

/**
 * Why an action is not allowed on the organization's current plan.
 * The reason is a full sentence shown to the person as is, so it names
 * the limit and what to do about it.
 */
export interface EntitlementRefusal {
  reason: string;
}

/**
 * Plan limits, supplied by a deployment that has them.
 *
 * The open source server has no plans and no billing: every check
 * passes vacuously when this is absent, which is the whole extension
 * point. A hosted deployment loads a module (BENTO_CLOUD_MODULE) that
 * fills it in and lives in its own repository; nothing in this one
 * knows what a plan is.
 * Checks receive the organization and answer null for "allowed".
 */
export interface Entitlements {
  /** Asked before an invitation is created. */
  canAddMember(organizationId: string): Promise<EntitlementRefusal | null>;
  /** Asked before a card leaves the backlog (or reopens): before it goes live. */
  canActivateFeature(organizationId: string): Promise<EntitlementRefusal | null>;
  /**
   * How many runs this organization may have working at once. Null is
   * unlimited. This is fairness rather than a paywall: without it one
   * tenant's queue occupies every worker on the instance and everybody
   * else waits behind it.
   */
  concurrentRunLimit?(organizationId: string): Promise<number | null>;
}

export interface AppContext {
  env: Env;
  db: Db;
  pool: pg.Pool;
  boss: PgBoss;
  bus: EventBus;
  driver: SandboxDriver;
  worktrees: WorktreeManager;
  /** Server-owned GitHub App; an installation is selected per organization. */
  githubApp?: GitHubApp;
  /** Absent in local mode, which runs without sign in. */
  auth?: Auth;
  /** Plan limits; absent on open source installs, where nothing is limited. */
  entitlements?: Entitlements;
  /** Encrypts organization secrets at rest. */
  secretBox: SecretBox;
  /**
   * Bytes of binary run artifacts. Null on a multi mode deploy with no
   * bucket configured, where capture keeps text artifacts and says in
   * the transcript that it skipped the files. Access control is never
   * here: it lives on the run_artifacts rows.
   */
  artifacts: ArtifactStore | null;
  /**
   * Live agent executions on this server, by run id, so a cancel
   * request can interrupt one. Runner-executed runs are not here: they
   * are cancelled by marking the row, which the runner sees when it
   * next reports.
   */
  running: Map<string, AbortController>;
  /**
   * Live agent sessions by run id: a handle that delivers a user
   * message into the working process's stdin. Present only while the
   * process is alive and the adapter supports a live conversation.
   */
  liveInputs: Map<string, LiveInput>;
  /**
   * Fallback user for local mode. In multi mode the acting user comes
   * from the request session instead; see middleware/actor.ts.
   */
  userId: string;
}

export function createDriver(env: Env): SandboxDriver {
  switch (env.BENTO_SANDBOX_DRIVER) {
    case "sprite": {
      if (!env.SPRITES_TOKEN) {
        throw new Error("BENTO_SANDBOX_DRIVER=sprite needs SPRITES_TOKEN");
      }
      return new SpriteDriver({
        token: env.SPRITES_TOKEN,
        ...(env.SPRITES_REGION ? { region: env.SPRITES_REGION } : {}),
      });
    }
    case "local-process":
      return new LocalProcessDriver();
    default:
      return new DockerDriver(undefined, env.BENTO_SANDBOX_RESTRICTED_NETWORK);
  }
}

/**
 * One client serves both roles. Returned as the app client rather than
 * either interface so the caller can put it in both slots: they are
 * separate interfaces because their callers differ, not because two
 * connections are wanted.
 */
export function createGitHubApp(env: Env): GitHubApp | undefined {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return undefined;
  return new GitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
  });
}

/** Local mode runs without sign-in; every resource belongs to this user. */
export async function ensureLocalUser(db: Db): Promise<string> {
  await db
    .insert(user)
    .values({
      id: LOCAL_USER_ID,
      name: "Local User",
      email: "local@bento.dev",
      emailVerified: true,
    })
    .onConflictDoNothing();
  return LOCAL_USER_ID;
}
