import type { Db } from "@bento/db";
import { user } from "@bento/db";
import { GitHubApp } from "@bento/github";
import { DockerDriver, LocalProcessDriver, SpriteDriver, WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import type PgBoss from "pg-boss";
import type pg from "pg";
import type { Analytics } from "./analytics.js";
import type { FeatureFlags } from "./feature-flags.js";
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
   * Asked inside startRunIfIdle, before any run is inserted.
   *
   * Going live is not the only moment a plan can run out. A card
   * already moving reaches its next stage hours later, and the team
   * may have spent everything it had in between, so the question has
   * to be asked again at the door where compute is actually spent.
   * Nothing already running is stopped: an agent killed mid edit
   * leaves a branch in a state nobody chose, and the time it has
   * spent is spent either way.
   */
  canStartRun?(organizationId: string, featureId?: string): Promise<EntitlementRefusal | null>;
  /**
   * Told once a run reached a terminal state, so a deployment that
   * meters compute can record what it cost.
   *
   * Never awaited on the caller's path and never allowed to fail one:
   * the run is over either way, and a metering error must not turn a
   * finished run into a failed one.
   */
  onRunFinished?(runId: string): Promise<void>;
  /**
   * Told after the headcount changed: a member joined or left, or an
   * invitation was created, cancelled or rejected.
   *
   * A deployment that bills per seat needs this, because the number it
   * charges for is the number of people in the organization, and
   * nothing else in this server has a reason to announce that. It is
   * never awaited on the caller's path and its failure is never the
   * user's problem: the invitation was sent either way, and the
   * deployment reconciles on its own.
   */
  onMembershipChanged?(organizationId: string): Promise<void>;
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
  /** PostHog, when a key is configured; absent means nothing is sent. */
  analytics?: Analytics;
  /**
   * Permanent feature flags (the beta-testers allowlist). Always
   * constructed: local mode is on, multi mode without a key is off.
   * Absent only in tests that never touch flags.
   */
  featureFlags?: FeatureFlags;
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
   * pg-boss ids of this process's `run.execute` workers, set by
   * registerJobs. enqueueRun wakes them, which is what lets idle
   * workers poll slowly without a queued run waiting on the poll.
   * Absent on a context that never registered jobs.
   */
  runWorkers?: string[];
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
  /**
   * True once this process has begun shutting down. Run loops stay
   * alive through the shutdown grace while their agents keep working in
   * the sandboxes, and the next boot reattaches to those agents; this
   * flag is what keeps the dying process from writing to transcripts
   * its successor now owns. Two processes writing one run's events is
   * how an agent's answer was once lost to a seq collision.
   */
  draining: boolean;
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
