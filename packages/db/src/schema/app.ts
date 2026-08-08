import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./identity.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The creator. Kept for attribution; access is decided by the org. */
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id),
  /**
   * Owning organization. Null in local mode, which has no orgs; in multi
   * mode every project belongs to one and all its members can see it.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /**
   * Repository fields kept for the single repo case and for GitHub gate
   * criteria, which act on one pull request. Multi repo projects use the
   * repositories table; these mirror its first entry.
   */
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch").notNull().default("main"),
  localPath: text("local_path"),
  githubRepoId: text("github_repo_id"),
  githubInstallationId: text("github_installation_id"),
  /**
   * Where this project's agents run. "server" uses the server's own
   * sandboxes; "runner" holds runs for a machine that claims them, which
   * is how a hosted board drives containers on your laptop.
   */
  executor: text("executor", { enum: ["server", "runner"] }).notNull().default("server"),
  ...timestamps,
});

/**
 * A project can span several repositories, so a feature that touches a
 * frontend and a backend is one card whose agents see both checkouts.
 * Each repository gets its own worktree inside the feature's workspace,
 * mounted at /workspace/<name>.
 */
export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** Directory name inside the workspace. Unique within the project. */
    name: text("name").notNull(),
    localPath: text("local_path").notNull(),
    repoUrl: text("repo_url"),
    /** GitHub repository id used to narrow installation tokens. */
    githubRepoId: text("github_repo_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    position: integer("position").notNull().default(0),
    /**
     * Shell run once in a fresh sandbox, before any agent starts.
     *
     * Sandboxes carry git and the agent CLIs and nothing else: no
     * language runtime, no package manager for the project. Which
     * toolchain a repository needs is a property of the repository, and
     * only the people who work in it know it, so they state it here.
     * A Node service says so; a Go service says something else; both
     * run on the same image.
     */
    setupCommand: text("setup_command"),
    /**
     * Shell the agent is told to run to prove its work: a build, a test
     * suite, or both. Bento does not run it, deliberately. The agent
     * needs the failures while it can still act on them, and a check
     * that only the server runs arrives after the agent has stopped.
     */
    testCommand: text("test_command"),
    ...timestamps,
  },
  (t) => [uniqueIndex("repositories_project_name_idx").on(t.projectId, t.name)],
);

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps,
});

export const agentProfiles = pgTable("agent_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cli: text("cli", { enum: ["claude-code", "codex", "cursor", "opencode", "pi", "fake"] }).notNull(),
  model: text("model").notNull(),
  /**
   * The agent's operating instructions, written by the user and fed
   * into every stage prompt this agent runs. This is where a team
   * defines what the agent's stage write-up must contain, which is
   * what makes hand-offs between stages dependable.
   */
  skill: text("skill"),
  permissionPreset: text("permission_preset").notNull().default("sandboxed-full"),
  extraArgs: jsonb("extra_args").$type<string[]>().notNull().default([]),
  /** Names of secrets to inject as env vars; values live in the secrets table. */
  envRefs: jsonb("env_refs").$type<string[]>().notNull().default([]),
  ...timestamps,
});

export const stages = pgTable(
  "stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    defaultAgentProfileId: uuid("default_agent_profile_id").references(() => agentProfiles.id),
    gateType: text("gate_type", { enum: ["manual", "auto"] }).notNull().default("manual"),
    gateCriteria: jsonb("gate_criteria").$type<unknown[]>().notNull().default([]),
    /**
     * When true, a successful run in this stage pushes the feature
     * branch and opens (or updates) the pull request. Off by default:
     * an investigation stage that commits nothing should not decide
     * whether the card reaches GitHub.
     */
    createPr: boolean("create_pr").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("stages_pipeline_slug_idx").on(t.pipelineId, t.slug)],
);

/**
 * Per organization policy that is not a plan and not a credential.
 *
 * A row exists only once a team has chosen something, so absence is the
 * default rather than a state to migrate into. Open source rather than
 * part of the hosted module: a self-hosted team wants to lock its
 * sandboxes down just as much as a paying one.
 */
export const organizationPolicies = pgTable("organization_policies", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Agents in this organization run with no route to the internet
   * except what the deployment explicitly allows. Opt in, because it
   * needs a restricted network configured on the host, and a run that
   * cannot reach its model provider fails rather than degrades.
   */
  restrictNetwork: boolean("restrict_network").notNull().default(false),
  /**
   * Whether the stage write-ups under docs/bento/ ride along into pull
   * requests. Off, because a reviewer opened a pull request to read a
   * change and found six generated markdown files in the diff. They
   * stay on the branch either way: that is how one stage's output
   * reaches the next.
   */
  includeStageNotesInPr: boolean("include_stage_notes_in_pr").notNull().default(false),
  ...timestamps,
});

export const features = pgTable("features", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  pipelineId: uuid("pipeline_id")
    .notNull()
    .references(() => pipelines.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["backlog", "active", "gated", "done", "cancelled"],
  })
    .notNull()
    .default("backlog"),
  currentStageId: uuid("current_stage_id").references(() => stages.id),
  boardPosition: numeric("board_position").notNull().default("0"),
  branchName: text("branch_name"),
  /**
   * The first repository's pull request, mirrored from
   * feature_pull_requests the same way the project mirrors its first
   * repository. A card spanning three repositories has three pull
   * requests; this is the one to show when there is only room for one.
   */
  prNumber: integer("pr_number"),
  ...timestamps,
});

/**
 * One pull request per repository a feature changed.
 *
 * A card spanning a frontend and a backend produces a pull request in
 * each, on the same branch, and it is only finished when both are. A
 * single `features.pr_number` could not express that, so it became the
 * mirror of the first and this table holds the truth.
 */
export const featurePullRequests = pgTable(
  "feature_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /**
     * Kept when the repository leaves the project, so a pull request
     * already open does not lose the record of where it was opened.
     */
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** Denormalized so a row still names its repository after a removal. */
    repoUrl: text("repo_url").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("feature_pull_requests_feature_repo_idx").on(t.featureId, t.repoUrl)],
);

/**
 * Everything that has happened to a feature, in one ordered log.
 *
 * Stage moves and status changes are one question ("what happened to
 * this card"), so they share a table rather than forcing every consumer
 * to union two and interleave by timestamp. kind discriminates them:
 * stage rows carry the stage columns, status rows carry the status
 * columns.
 *
 * toStageId is nullable because two moves have no destination stage:
 * returning to the backlog, and completing the pipeline.
 */
export const featureEvents = pgTable(
  "feature_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["stage_moved", "status_changed"] }).notNull(),

    fromStageId: uuid("from_stage_id").references(() => stages.id),
    /** Null means the backlog, or the end of the pipeline. */
    toStageId: uuid("to_stage_id").references(() => stages.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),

    /** Distinguishes direction, which stage ids alone do not. */
    trigger: text("trigger", {
      enum: ["manual", "manual_back", "gate_auto", "gate_auto_back", "agent_run", "system"],
    }).notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    /** The run that caused this, when one did. */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** Why, when there is a why: which criterion failed, and so on. */
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feature_events_feature_at_idx").on(t.featureId, t.at),
    check(
      "feature_events_kind_shape",
      sql`(${t.kind} = 'stage_moved' and ${t.fromStatus} is null and ${t.toStatus} is null)
        or (${t.kind} = 'status_changed' and ${t.toStatus} is not null)`,
    ),
  ],
);


export const sandboxes = pgTable("sandboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  featureId: uuid("feature_id").references(() => features.id, { onDelete: "set null" }),
  provider: text("provider", { enum: ["docker", "sprite"] }).notNull(),
  externalId: text("external_id").notNull(),
  status: text("status", {
    enum: ["provisioning", "ready", "busy", "hibernated", "destroyed"],
  })
    .notNull()
    .default("provisioning"),
  workdir: text("workdir").notNull().default("/workspace"),
  /**
   * Which setup commands this sandbox has already run, as a hash of
   * them all. A sandbox outlives the run that made it, so installing a
   * toolchain is a once-per-sandbox cost rather than a once-per-run
   * one; editing a setup command changes the hash, and the next run
   * installs again.
   */
  setupFingerprint: text("setup_fingerprint"),
  imageRef: text("image_ref"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  ...timestamps,
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  featureId: uuid("feature_id")
    .notNull()
    .references(() => features.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  stageId: uuid("stage_id")
    .notNull()
    .references(() => stages.id),
  /**
   * Deleting an agent takes its runs with it, transcripts included.
   *
   * This used to refuse, on the grounds that a run is history and
   * history should not vanish. In practice it meant an agent somebody
   * tried once could never be removed, and the board filled with names
   * nobody uses. The card's own event log survives: feature_events
   * keeps its row and drops only the link to the run.
   */
  agentProfileId: uuid("agent_profile_id")
    .notNull()
    .references(() => agentProfiles.id, { onDelete: "cascade" }),
  sandboxId: uuid("sandbox_id").references(() => sandboxes.id),
  status: text("status", {
    enum: ["queued", "starting", "running", "succeeded", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  prompt: text("prompt").notNull(),
  /** Copied from the project when the run is created. */
  executor: text("executor", { enum: ["server", "runner"] }).notNull().default("server"),
  /** Sandbox snapshot taken before this run, for rolling it back. */
  checkpointId: text("checkpoint_id"),
  /** Which runner claimed this run, for runner-executed work. */
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  cliSessionId: text("cli_session_id"),
  exitCode: integer("exit_code"),
  costUsd: numeric("cost_usd"),
  numTurns: integer("num_turns"),
  error: text("error"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
);

/**
 * A message sent to a card's agent, with its own lifecycle. This
 * replaced a single queued_prompt column on features, which was a slot
 * rather than a queue: no identity per message, no delivery state, and
 * no owner to retry, so racing messages overwrote each other and a
 * claimed one could vanish after its sender had been told "queued".
 *
 * queued: parked, waiting for an agent to hear it. sent: handed to a
 * run, as a live stdin line or as a resume run's prompt. delivered: a
 * later result event confirmed the run answered while it was on the
 * conversation. A run that ends with sent messages puts them back to
 * queued, so a message the agent never read reaches the next run
 * instead of vanishing while the transcript shows it.
 */
export const featureMessages = pgTable(
  "feature_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    status: text("status", { enum: ["queued", "sent", "delivered"] })
      .notNull()
      .default("queued"),
    /** The run that consumed this message; null while it waits. */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("feature_messages_claim_idx").on(t.featureId, t.status, t.createdAt)],
);

export const gateChecks = pgTable("gate_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  featureId: uuid("feature_id")
    .notNull()
    .references(() => features.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  stageId: uuid("stage_id")
    .notNull()
    .references(() => stages.id),
  criterion: jsonb("criterion").notNull(),
  status: text("status", { enum: ["pending", "passed", "failed"] }).notNull().default("pending"),
  detail: jsonb("detail"),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  ...timestamps,
});

/**
 * Agent credentials, encrypted at rest. Scoped to an organization so a
 * team shares one set of keys and the operator's own credentials are
 * never handed to a tenant's sandbox. organizationId is null in local
 * mode, which has no organizations.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    /** Masked tail, so the UI can show which key is stored. */
    hint: text("hint").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("secrets_org_name_idx").on(t.organizationId, t.name),
    uniqueIndex("secrets_local_name_idx").on(t.name).where(sql`${t.organizationId} is null`),
  ],
);

/** One GitHub App installation selected by each hosted organization. */
export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  installationId: text("installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  installedBy: text("installed_by")
    .notNull()
    .references(() => user.id),
  ...timestamps,
});
