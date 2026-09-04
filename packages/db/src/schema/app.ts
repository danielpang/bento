import {
  type AnyPgColumn,
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
  /**
   * Whether an issue arriving from Linear enters this project's first
   * stage instead of waiting in the backlog. Per project, because one
   * team's intake is triaged by a person and another's is meant to be
   * picked up like a CI job. Off by default: it puts an agent on a
   * ticket nobody has read yet.
   */
  autoStartPipeline: boolean("auto_start_pipeline").notNull().default(false),
  /**
   * Whether a card created in this project files an issue in Linear. On
   * by default: a connected workspace is one someone wants their work to
   * show up in, and a card with no issue is the surprise, not the other
   * way round. Meaningless until the organization connects Linear.
   */
  linearCreateIssues: boolean("linear_create_issues").notNull().default(true),
  /**
   * Where those issues go when no Linear team is mapped to this project.
   * The team is required for a create, so an unset team means nothing is
   * filed; the key and name are kept so settings can name the team
   * without calling Linear. The Linear project is optional, and belongs
   * to that team.
   */
  linearTeamId: text("linear_team_id"),
  linearTeamKey: text("linear_team_key"),
  linearTeamName: text("linear_team_name"),
  linearProjectId: text("linear_project_id"),
  linearProjectName: text("linear_project_name"),
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
  cli: text("cli", { enum: ["claude-code", "codex", "cursor", "opencode", "pi", "pool", "dsh", "fake"] }).notNull(),
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

export const features = pgTable(
  "features",
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
  },
  // Postgres does not index FK columns on its own, and every board,
  // run, and session query starts from "the cards of this project".
  (t) => [index("features_project_idx").on(t.projectId)],
);

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
    /**
     * The commit Bento last pushed to the branch, which is the lease
     * the next force push holds. Read at push time, the remote's head
     * can only ever agree with itself; read from here, a commit a
     * reviewer pushed in between fails the lease instead of being
     * silently rewritten away. Null before the first recorded push,
     * which falls back to the read-at-push behavior.
     */
    headSha: text("head_sha"),
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
      enum: ["manual", "manual_back", "gate_auto", "gate_auto_back", "agent_run", "linear_auto", "system"],
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
    // The spend page counts completions over time: for each done card,
    // the latest status_changed-to-done event. A partial index keeps
    // that lookup on completion rows only, instead of walking every
    // stage move a busy card has ever made.
    index("feature_events_completions_idx")
      .on(t.featureId, t.at)
      .where(sql`${t.kind} = 'status_changed' and ${t.toStatus} = 'done'`),
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
  /**
   * The swarm this machine belongs to, and the task it was made for.
   *
   * Both are kept because the two are asked for separately: the reaper
   * finds a worker's machine by its leaf task, and stopping a swarm has
   * to find every machine under it without walking the tree. Nulled
   * rather than cascaded, like featureId: a row that outlives its work
   * still names a machine somebody has to clean up.
   */
  swarmId: uuid("swarm_id").references((): AnyPgColumn => swarms.id, { onDelete: "set null" }),
  swarmTaskId: uuid("swarm_task_id").references((): AnyPgColumn => swarmTasks.id, { onDelete: "set null" }),
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
  /**
   * The shape of machine this is, named from the driver's own
   * configuration at provision time.
   *
   * Recorded rather than looked up, because it is a fact about what was
   * paid for and the deployment's configuration can change underneath
   * it. A deployment that moves its default from two cores to four must
   * not retroactively reprice last month's hours. Null on sandboxes
   * created before this column, and on the local drivers, where nobody
   * is billed for a container on their own machine.
   */
  size: text("size"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  ...timestamps,
},
  /**
   * One machine, one row.
   *
   * Both drivers derive a stable name from the feature (`bento-<id>`
   * for a sprite, `bento-sbx-<id>` for a container) and reuse it, so a
   * card has exactly one machine however many stages it runs. The
   * insert in run-executor already reads as though it knows that: it
   * says `onConflictDoNothing()` and falls back to selecting the row
   * that must already exist. Without this index there was nothing for
   * that conflict to fire on, so every run inserted another row naming
   * the same machine, and the reaper marked one of them destroyed
   * while the rest went on claiming a machine that was gone.
   */
  (t) => [uniqueIndex("sandboxes_external_id_idx").on(t.externalId)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The card this run works on, for a pipeline run. Null on a swarm
   * run, which is keyed by its swarm and task instead. Exactly one of
   * featureId and swarmId is set, and a check constraint holds every
   * insert to that.
   */
  featureId: uuid("feature_id").references(() => features.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the owning project so row-level security can be a
   * column comparison rather than a join. Null means "belongs to no
   * organization", which is local mode. Set on insert; never changed.
   */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  /**
   * The pipeline stage this run belongs to. Null on a swarm run: a
   * swarm carries a task tree rather than a pipeline, so there is no
   * stage to name. Every card run still has one, which the run tenant
   * trigger enforces.
   */
  stageId: uuid("stage_id").references(() => stages.id),
  /** The swarm this run works for. Null on a pipeline run. */
  swarmId: uuid("swarm_id").references((): AnyPgColumn => swarms.id, { onDelete: "cascade" }),
  /**
   * The task inside that swarm. Null for a run that acts on the swarm
   * as a whole: the planner, and the merge queue's resolver.
   */
  swarmTaskId: uuid("swarm_task_id").references((): AnyPgColumn => swarmTasks.id, { onDelete: "cascade" }),
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
  /**
   * Who asked for this run.
   *
   * Compute is pooled across a team, so "one person used it all" is a
   * thing teams need to be able to say to each other, and until this
   * existed nothing could answer it. Null for the runs nobody started:
   * a stage handed on by the gate evaluator, and a judge agent.
   *
   * Nulled rather than cascaded when the user goes: the run and its
   * hours survive a deleted account, which a cascade would take with
   * it and leave the month's totals short.
   *
   * The name is not preserved here, and deliberately not. A deployment
   * that needs last month's usage page to keep agreeing with last
   * month's bill snapshots the name onto its own usage ledger when the
   * run finishes, because that is a billing record and this is a
   * foreign key. Making this column restrict deletion instead would
   * mean an account could not be deleted at all once it had run
   * anything.
   */
  startedBy: text("started_by").references(() => user.id, { onDelete: "set null" }),
  status: text("status", {
    enum: ["queued", "starting", "running", "succeeded", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  prompt: text("prompt").notNull(),
  /**
   * What this run is, structurally. "judge" is the gate evaluator's
   * completion check; "rebase" is the resolve-conflicts button, a work
   * run whose finish must republish the branch whatever the stage's
   * publish setting says; everything else is work someone can talk to.
   * A column rather than a prompt-prefix test, because the prompt is
   * user-reachable text: a chat message that happened to open with the
   * judge sentence used to make its run drop out of every "not a
   * judge" query in the server.
   */
  kind: text("kind", { enum: ["task", "judge", "rebase"] }).notNull().default("task"),
  /**
   * Which job this run holds, across both board modes.
   *
   * `kind` says what a card run is structurally and keeps its meaning
   * for the pipeline; this says which of the two boards asked for the
   * run and in what capacity, so a query can ask for "this swarm's
   * workers" without knowing anything about stages. Existing rows are
   * backfilled to "stage", which is what they all were.
   */
  role: text("role", {
    enum: ["stage", "judge", "rebase", "planner", "subplanner", "worker", "resolver"],
  })
    .notNull()
    .default("stage"),
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
  },
  (t) => [
    // "This card's runs, newest first" is the shape of every
    // conversation, resume, and session query; without this it is a
    // table scan per ask.
    index("agent_runs_feature_queued_idx").on(t.featureId, t.queuedAt),
    // The same question asked of a swarm, which reads its runs by
    // swarm rather than by card.
    index("agent_runs_swarm_queued_idx").on(t.swarmId, t.queuedAt),
    /**
     * A run belongs to a card or to a swarm, never to both and never
     * to neither. Written as a constraint rather than left to the
     * routes, because both boards insert runs and a run with no owner
     * is invisible to every list either board draws.
     */
    check("agent_runs_feature_or_swarm", sql`(${t.featureId} is null) <> (${t.swarmId} is null)`),
  ],
);

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
    /**
     * Who wrote it. A continuation run started by this message acts with
     * the author's per-user MCP connections, so attribution here is what
     * keeps member B's follow-up from using member A's tokens. Null for
     * messages that predate the column.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
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

/**
 * Files an agent produced for people to look at, captured from the
 * sandbox when its run ends: the stage write-up, design mockups,
 * diagrams, screenshots, HTML previews.
 *
 * Rows are per run rather than per feature, so the design stage's
 * output is still readable after the implementation stage rewrote the
 * branch. Text stays inline in `content`; binary files live in the
 * artifact store and `storageKey` names them there. Exactly one of the
 * two is set, and the check constraint holds inserts to it.
 */
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /**
     * The card this artifact was produced for. Null on a swarm's
     * artifact, which is keyed by swarm and task instead; exactly one
     * of featureId and swarmId is set.
     */
    featureId: uuid("feature_id").references(() => features.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** The swarm this artifact belongs to, and the task that made it. */
    swarmId: uuid("swarm_id").references((): AnyPgColumn => swarms.id, { onDelete: "cascade" }),
    swarmTaskId: uuid("swarm_task_id").references((): AnyPgColumn => swarmTasks.id, { onDelete: "cascade" }),
    /**
     * The stage as it was when the run happened, held by value rather
     * than by reference: an artifact is a record, and renaming or
     * deleting the stage later must not orphan or block it.
     */
    stageSlug: text("stage_slug").notNull(),
    stageName: text("stage_name").notNull(),
    // A swarm has no stages, so a swarm artifact records the task that
    // produced it here: its slug and its title. The columns keep their
    // pipeline names because every existing reader is a pipeline one;
    // do not invent a placeholder stage to fill them.
    /** Where the agent wrote it, relative to the workspace. Display only. */
    path: text("path").notNull(),
    kind: text("kind", { enum: ["markdown", "mermaid", "image", "html", "file"] }).notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** Inline body for text artifacts. */
    content: text("content"),
    /** Artifact store key for binary artifacts. */
    storageKey: text("storage_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_artifacts_feature_idx").on(t.featureId, t.createdAt),
    index("run_artifacts_run_idx").on(t.runId),
    index("run_artifacts_swarm_idx").on(t.swarmId, t.createdAt),
    check("run_artifacts_content_or_key", sql`(${t.content} is null) <> (${t.storageKey} is null)`),
    /** An artifact belongs to a card or to a swarm, the same way its run does. */
    check("run_artifacts_feature_or_swarm", sql`(${t.featureId} is null) <> (${t.swarmId} is null)`),
  ],
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

/**
 * One Linear workspace connection per organization, keyed by a personal
 * API key encrypted at rest. organizationId is null in local mode, and a
 * partial unique index keeps local mode to a single connection.
 */
export const linearConnections = pgTable(
  "linear_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    /** Masked tail, so the UI can show which key is stored. */
    hint: text("hint").notNull().default(""),
    /** Linear's id for the webhook we provisioned, when we could. */
    webhookId: text("webhook_id"),
    encryptedWebhookSecret: text("encrypted_webhook_secret"),
    /** Target project for "bento" label imports from unmapped teams. */
    defaultProjectId: uuid("default_project_id").references(() => projects.id, { onDelete: "set null" }),
    // Whether a card files an issue, and into which team and Linear
    // project, lives on the projects table: each project decides for
    // itself, so those columns are not here.
    ...timestamps,
  },
  (t) => [
    uniqueIndex("linear_connections_org_idx").on(t.organizationId),
    uniqueIndex("linear_connections_local_idx").on(sql`(organization_id is null)`).where(sql`${t.organizationId} is null`),
  ],
);

/** Maps a Linear team to the Bento project its backlog syncs into. */
export const linearTeamMappings = pgTable(
  "linear_team_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    linearTeamId: text("linear_team_id").notNull(),
    linearTeamKey: text("linear_team_key").notNull(),
    linearTeamName: text("linear_team_name").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("linear_team_mappings_org_team_idx").on(t.organizationId, t.linearTeamId),
    uniqueIndex("linear_team_mappings_local_team_idx").on(t.linearTeamId).where(sql`${t.organizationId} is null`),
  ],
);

/**
 * Links an imported Linear issue to its Bento feature. The unique issue
 * index is the dedupe that keeps webhook, sweep, and manual import from
 * creating the same feature twice.
 */
export const linearIssueLinks = pgTable(
  "linear_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .unique()
      .references(() => features.id, { onDelete: "cascade" }),
    linearIssueId: text("linear_issue_id").notNull(),
    linearIssueIdentifier: text("linear_issue_identifier").notNull(),
    linearIssueUrl: text("linear_issue_url").notNull(),
    linearTeamId: text("linear_team_id").notNull(),
    /**
     * The last Linear state type Bento pushed, so the webhook that echoes
     * our own update back can be recognized and dropped.
     */
    lastOutboundStateType: text("last_outbound_state_type"),
    lastInboundUpdatedAt: timestamp("last_inbound_updated_at", { withTimezone: true }),
    /** Set when Linear deletes the issue; the feature stays. */
    stale: boolean("stale").notNull().default(false),
    /**
     * Set while Bento is filing this issue and not yet sure it exists.
     *
     * A card created in Bento reserves its link, with the issue id it
     * is about to ask Linear for, before it calls Linear at all. That
     * reservation is what makes the filing safe to retry: a second
     * attempt finds it and recovers the issue rather than filing
     * another one. It also claims the issue id before Linear's webhook
     * can announce the issue back to us, which would otherwise import
     * Bento's own new issue as a second card.
     */
    pending: boolean("pending").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("linear_issue_links_org_issue_idx").on(t.organizationId, t.linearIssueId),
    uniqueIndex("linear_issue_links_local_issue_idx").on(t.linearIssueId).where(sql`${t.organizationId} is null`),
  ],
);

/**
 * One Slack workspace connection per organization. The bot token is
 * encrypted at rest. organizationId is null in local mode, and a
 * partial unique index keeps local mode to a single connection.
 */
export const slackConnections = pgTable(
  "slack_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    slackTeamId: text("slack_team_id").notNull(),
    slackTeamName: text("slack_team_name").notNull(),
    botUserId: text("bot_user_id").notNull(),
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    installedBy: text("installed_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("slack_connections_org_idx").on(t.organizationId),
    uniqueIndex("slack_connections_local_idx").on(sql`(organization_id is null)`).where(sql`${t.organizationId} is null`),
    uniqueIndex("slack_connections_team_idx").on(t.slackTeamId),
  ],
);

/**
 * Per-member Slack preferences. The default project is what @bento
 * uses when creating a card; slackUserId is filled on the first
 * successful email match so later lookups do not depend on Slack
 * exposing the member's email.
 */
export const slackUserSettings = pgTable(
  "slack_user_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id"),
    defaultProjectId: uuid("default_project_id").references(() => projects.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("slack_user_settings_org_user_idx").on(t.organizationId, t.userId),
    uniqueIndex("slack_user_settings_local_user_idx").on(t.userId).where(sql`${t.organizationId} is null`),
    uniqueIndex("slack_user_settings_org_slack_user_idx")
      .on(t.organizationId, t.slackUserId)
      .where(sql`${t.slackUserId} is not null`),
    uniqueIndex("slack_user_settings_local_slack_user_idx")
      .on(t.slackUserId)
      .where(sql`${t.organizationId} is null AND ${t.slackUserId} is not null`),
  ],
);

/**
 * Links a Slack-created card to the thread that created it. Notify
 * jobs no-op without this row, so Bento-only cards stay off Slack.
 */
export const slackThreadLinks = pgTable(
  "slack_thread_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .unique()
      .references(() => features.id, { onDelete: "cascade" }),
    slackTeamId: text("slack_team_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    /** ts of the needs-review message, so a later decision can update it. */
    reviewMessageTs: text("review_message_ts"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("slack_thread_links_org_feature_idx").on(t.organizationId, t.featureId),
    uniqueIndex("slack_thread_links_local_feature_idx").on(t.featureId).where(sql`${t.organizationId} is null`),
    uniqueIndex("slack_thread_links_thread_idx").on(t.slackTeamId, t.slackChannelId, t.slackThreadTs),
  ],
);

/**
 * Short-lived @bento mention waiting on a project picker. Expires so
 * an abandoned picker cannot create a card later under a stale title.
 */
export const slackPendingMentions = pgTable(
  "slack_pending_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("slack_pending_mentions_expires_idx").on(t.expiresAt),
    uniqueIndex("slack_pending_mentions_thread_idx").on(t.slackTeamId, t.slackChannelId, t.slackThreadTs),
  ],
);

/**
 * Remote MCP servers an organization defines once for every agent
 * harness. Agents never see this row's URL directly: runs are handed a
 * gateway URL plus a run-scoped token, and the gateway attaches the
 * real credential server side. organizationId is null in local mode.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The creator. Kept for attribution; access is decided by the org. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Null is a team server, the registry every run draws from. Set, it
     * is one member's personal server: only runs that member starts get
     * it, only their own credential is ever attached, and the team's
     * admins can see and remove it but a run started by anyone else
     * never sees it at all.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Stable key the harness configs use; [a-z0-9-]. */
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    transport: text("transport", { enum: ["http", "sse"] }).notNull().default("http"),
    authType: text("auth_type", { enum: ["none", "api_key", "oauth"] }).notNull(),
    /**
     * Whose credential the gateway attaches: the organization's shared
     * one, or each member's own. Only meaningful for oauth servers; API
     * keys are always organization wide.
     */
    credentialScope: text("credential_scope", { enum: ["org", "user"] }).notNull().default("org"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Header carrying an API key upstream. "Authorization" sends
     * "Bearer <key>"; any other name sends the raw key. Validated at
     * write time against a denylist so it cannot shadow proxied headers.
     */
    apiKeyHeader: text("api_key_header").notNull().default("Authorization"),
    // OAuth client (manual entry or RFC 7591 dynamic registration) and
    // the discovery cache (RFC 9728 resource metadata, then RFC 8414).
    // Cleared whenever the URL origin, auth type, or credential scope
    // changes: credentials must never outlive the endpoints they were
    // minted against, or an admin could repoint the URL and harvest them.
    clientId: text("client_id"),
    encryptedClientSecret: text("encrypted_client_secret"),
    clientRegistration: text("client_registration", { enum: ["manual", "dynamic"] }),
    authorizationEndpoint: text("authorization_endpoint"),
    tokenEndpoint: text("token_endpoint"),
    registrationEndpoint: text("registration_endpoint"),
    issuer: text("issuer"),
    /**
     * RFC 9207: the authorization server advertised that it returns an
     * issuer on the authorization response. When true, the callback
     * requires that issuer and refuses a response that omits it.
     */
    issParamSupported: boolean("iss_param_supported").notNull().default(false),
    /** RFC 8707 resource indicator; defaults to the server URL. */
    resource: text("resource"),
    scopes: text("scopes"),
    metadataDiscoveredAt: timestamp("metadata_discovered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Slugs are unique among team servers, and separately per member
    // among their personal ones. A personal slug may equal a team slug;
    // the run pipeline resolves that collision in the team's favor.
    uniqueIndex("mcp_servers_org_slug_idx").on(t.organizationId, t.slug).where(sql`${t.userId} is null`),
    uniqueIndex("mcp_servers_local_slug_idx")
      .on(t.slug)
      .where(sql`${t.organizationId} is null and ${t.userId} is null`),
    uniqueIndex("mcp_servers_org_user_slug_idx")
      .on(t.organizationId, t.userId, t.slug)
      .where(sql`${t.userId} is not null`),
    uniqueIndex("mcp_servers_local_user_slug_idx")
      .on(t.userId, t.slug)
      .where(sql`${t.organizationId} is null and ${t.userId} is not null`),
  ],
);

/**
 * A credential for one MCP server, encrypted at rest. userId null is
 * the organization's shared credential (an API key or an org-wide OAuth
 * grant); a non-null userId is one member's personal connection. The
 * gateway never falls back from one to the other: a per-user server
 * with no row for the acting user simply is not attached to the run.
 */
export const mcpCredentials = pgTable(
  "mcp_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** Filled by the inherit trigger from the parent server row. */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["api_key", "oauth"] }).notNull(),
    /** SecretBox ciphertext: the API key, or the OAuth access token. */
    encryptedSecret: text("encrypted_secret").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** OAuth scopes actually granted. */
    scope: text("scope"),
    /**
     * Origin of the token endpoint this credential was minted against.
     * Refresh refuses on mismatch, so repointing a server's discovery
     * cannot ship the refresh token somewhere new.
     */
    tokenEndpointOrigin: text("token_endpoint_origin"),
    /** Masked tail for API keys, so the UI can show which key is stored. */
    hint: text("hint").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_credentials_server_user_idx").on(t.serverId, t.userId),
    uniqueIndex("mcp_credentials_server_org_idx").on(t.serverId).where(sql`${t.userId} is null`),
  ],
);

/**
 * The run-scoped token a sandbox holds instead of any real credential.
 * Only the sha256 of the token is stored; the raw value is written into
 * the sandbox's harness configs and dies when the run settles. Rows are
 * minted, extended, revoked, and swept exclusively by orchestrator code
 * on the owner pool, so bento_user gets no DML on this table.
 */
export const mcpRunGrants = pgTable(
  "mcp_run_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Filled by the inherit trigger from the parent run row. */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The swarm whose run holds this grant, copied at mint. Null for a
     * pipeline run. Carried here so stopping a swarm can revoke every
     * grant it minted without joining back through its runs.
     */
    swarmId: uuid("swarm_id").references((): AnyPgColumn => swarms.id, { onDelete: "cascade" }),
    /**
     * The member whose per-user connections this run may use, from
     * agent_runs.started_by at mint. Null means auto-started: per-user
     * servers are then never attached, and the gateway refuses them.
     */
    actingUserId: text("acting_user_id").references(() => user.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    /** Servers pinned at mint; the gateway refuses ids outside this set. */
    serverIds: jsonb("server_ids").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_run_grants_run_idx").on(t.runId),
    uniqueIndex("mcp_run_grants_token_idx").on(t.tokenHash),
    index("mcp_run_grants_expires_idx").on(t.expiresAt),
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

/**
 * A swarm is the board's second mode: one goal, decomposed by a planner
 * into a tree of tasks, worked by several agents at once, landed onto
 * one branch by a server-owned merge queue.
 *
 * Nothing below replaces the pipeline. A card is a lane a person walks
 * a change down; a swarm is a fan-out somebody starts and watches. They
 * share a project, a repository set, and the agent profiles, and they
 * share agent_runs: a run belongs to a card or to a swarm, and the
 * check constraint on that table is what keeps it from belonging to
 * neither.
 */

/**
 * A reusable swarm setup: who plans, who works, and the ceilings the
 * swarm starts with.
 *
 * Owner-keyed like agent_profiles rather than parented by a project, so
 * one team's way of running a swarm is not re-entered per project.
 * There is no parent row to inherit an organization from, so the routes
 * set organizationId explicitly, which is the agent_profiles and
 * mcp_servers precedent.
 */
export const swarmTemplates = pgTable("swarm_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The creator. Kept for attribution; access is decided by the org. */
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Who decomposes the goal, and who works the leaves. */
  plannerProfileId: uuid("planner_profile_id").references(() => agentProfiles.id, { onDelete: "set null" }),
  workerProfileId: uuid("worker_profile_id").references(() => agentProfiles.id, { onDelete: "set null" }),
  /**
   * Operating instructions handed to those agents on top of their own
   * profile skill: how to split this kind of goal, and what a finished
   * leaf has to have done.
   */
  plannerInstructions: text("planner_instructions"),
  workerInstructions: text("worker_instructions"),
  /** Starting ceilings. A swarm copies them and may then be changed. */
  maxWorkers: integer("max_workers").notNull().default(4),
  budgetUsd: numeric("budget_usd"),
  timeLimitMin: integer("time_limit_min"),
  ...timestamps,
});

/**
 * One goal being worked by a swarm of agents.
 *
 * The ceilings are on the swarm rather than on the plan, because they
 * are what a person actually sets before letting several agents loose:
 * how much money, how many at once, how long. The three spend columns
 * are the same total counted three ways, from most trustworthy to
 * least: what a provider reported, what the harness estimated from
 * tokens, and what had to be assumed for a run that reported nothing.
 * Keeping them apart is what lets a later phase show a number and say
 * how much of it is known. Nothing here tiers them; they are columns.
 */
export const swarms = pgTable(
  "swarms",
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
    /** Stable handle inside the project, used in branch names and URLs. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** What the swarm was asked to do, as the person wrote it. */
    goal: text("goal").notNull().default(""),
    /** The template this was started from, kept for attribution only. */
    templateId: uuid("template_id").references(() => swarmTemplates.id, { onDelete: "set null" }),
    status: text("status", {
      enum: ["draft", "planning", "running", "paused", "blocked", "done", "failed", "cancelled"],
    })
      .notNull()
      .default("draft"),
    /**
     * Why a paused swarm is paused. A person pausing it and a ceiling
     * stopping it both leave the same status, and only this tells the
     * board which sentence to print and whether resuming is a button
     * or a plan change.
     */
    pausedReason: text("paused_reason", {
      enum: ["manual", "budget", "time_limit", "attention", "plan_limit", "error"],
    }),
    /** The single branch every task lands onto. */
    branchName: text("branch_name"),
    /**
     * The swarm's own machine: where the planner runs and where the
     * merge queue does its landings. Workers get their own, recorded on
     * sandboxes with the leaf they belong to.
     */
    sandboxId: uuid("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    /** Ceilings, copied from the template at start. Null means none. */
    budgetUsd: numeric("budget_usd"),
    maxWorkers: integer("max_workers").notNull().default(4),
    timeLimitMin: integer("time_limit_min"),
    /** Spend so far, by how well it is known. See the table comment. */
    spentMeasuredUsd: numeric("spent_measured_usd").notNull().default("0"),
    spentEstimatedUsd: numeric("spent_estimated_usd").notNull().default("0"),
    spentAssumedUsd: numeric("spent_assumed_usd").notNull().default("0"),
    /**
     * Who started it. Nulled rather than cascaded when the account goes,
     * for the reason agent_runs.started_by is: the swarm and its hours
     * outlive the person who asked for them.
     */
    startedBy: text("started_by").references(() => user.id, { onDelete: "set null" }),
    /** Set when a finished swarm is put away. The rows stay. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Drives "pick up where you left off" without touching updatedAt. */
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("swarms_project_slug_idx").on(t.projectId, t.slug),
    index("swarms_project_idx").on(t.projectId),
  ],
);

/**
 * One node of a swarm's plan.
 *
 * The tree is the plan: a group is a decomposition the planner made, a
 * task is a leaf an agent works. parentId is null at the top, and the
 * swarm itself is the root nobody stores. position orders siblings, so
 * the board can draw the plan without inventing an order of its own.
 */
export const swarmTasks = pgTable(
  "swarm_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** Null at the top of the tree. Deleting a node takes its subtree. */
    parentId: uuid("parent_id").references((): AnyPgColumn => swarmTasks.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    /**
     * A group is decomposed further and never worked directly; a task
     * is a leaf an agent is given. A subplanner turns a group into more
     * of both, which is why the two share a table.
     */
    kind: text("kind", { enum: ["group", "task"] }).notNull().default("task"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", {
      enum: [
        "pending",
        "planning",
        "ready",
        "running",
        "blocked",
        "landing",
        "done",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    /**
     * Why this task wants a person, or null when it does not.
     *
     * Separate from status because a swarm that stops for a question is
     * still running everything else, and a board that has to be read
     * for a stalled leaf is a board nobody reads.
     */
    attention: text("attention", {
      enum: ["question", "blocked", "failed", "conflict", "budget"],
    }),
    /**
     * Rough size, set by the planner. Used to order work and to spread
     * the budget, never to bill: nothing here is a measurement.
     */
    weight: integer("weight").notNull().default(1),
    /** The branch this leaf's work is on, before it lands. */
    branchName: text("branch_name"),
    /**
     * The run currently working this task. Nulled rather than cascaded
     * when the run is deleted: the task outlives the attempt, and a
     * cascade would take the plan with the transcript.
     */
    assignedRunId: uuid("assigned_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /**
     * Coordinator bookkeeping the tree needs but nobody queries across:
     * retry counts, which sibling blocked this one, the planner's own
     * notes about a split. A column rather than a table, because it is
     * read only with the row it hangs off.
     */
    flags: jsonb("flags").$type<Record<string, unknown>>().notNull().default({}),
    /** What the worker said it did, once it was done. */
    report: text("report"),
    /** Spend attributed to this task, counted the three ways a swarm's is. */
    costMeasuredUsd: numeric("cost_measured_usd").notNull().default("0"),
    costEstimatedUsd: numeric("cost_estimated_usd").notNull().default("0"),
    costAssumedUsd: numeric("cost_assumed_usd").notNull().default("0"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  // Drawing the plan is "the children of this node, in order", once per
  // node, so the tree is one index rather than a scan per level.
  (t) => [index("swarm_tasks_tree_idx").on(t.swarmId, t.parentId, t.position)],
);

/**
 * Everything that has happened to one task, in order. Append only: a
 * status is a current value and this is how it got there, which is the
 * only account a person has of a swarm that ran while they were away.
 */
export const swarmTaskEvents = pgTable(
  "swarm_task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => swarmTasks.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "created",
        "status_changed",
        "assigned",
        "attention_raised",
        "attention_cleared",
        "reported",
        "landed",
        "note",
      ],
    }).notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    /** The run that caused this, when one did. */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => user.id),
    /** Why, when there is a why: the conflict, the failure, the question. */
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("swarm_task_events_task_at_idx").on(t.taskId, t.at)],
);

/**
 * The merge queue: finished work waiting to go onto the swarm's branch.
 *
 * One landing at a time is the whole point of the queue, and it is a
 * database fact here rather than a property of whichever job happens to
 * be running: the partial unique index refuses a second row in the
 * landing state for the same swarm, so two coordinators, a retry, and a
 * restarted server cannot land two branches onto one at once.
 */
export const swarmLandings = pgTable(
  "swarm_landings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** The leaf whose branch this lands. */
    taskId: uuid("task_id")
      .notNull()
      .references(() => swarmTasks.id, { onDelete: "cascade" }),
    /** Denormalized so a landing still names its branch after a replan. */
    branchName: text("branch_name"),
    /** Queue order, lowest first. */
    position: integer("position").notNull().default(0),
    status: text("status", {
      enum: ["queued", "landing", "landed", "conflicted", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    /**
     * The agent asked to resolve a conflict this landing hit. Nulled
     * rather than cascaded, like every other run reference on a row
     * that outlives the attempt.
     */
    resolverRunId: uuid("resolver_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** How many times this branch has been tried. */
    attempt: integer("attempt").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("swarm_landings_queue_idx").on(t.swarmId, t.position),
    uniqueIndex("swarm_landings_one_in_flight_idx")
      .on(t.swarmId)
      .where(sql`${t.status} = 'landing'`),
  ],
);

/**
 * One pull request per repository a swarm changed, the way a card's
 * feature_pull_requests works. A swarm lands everything onto one
 * branch, so this is that branch's pull request in each repository.
 */
export const swarmPullRequests = pgTable(
  "swarm_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
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
    /**
     * The commit Bento last pushed to the branch, which is the lease the
     * next force push holds. See feature_pull_requests.head_sha.
     */
    headSha: text("head_sha"),
    ...timestamps,
  },
  (t) => [uniqueIndex("swarm_pull_requests_swarm_repo_idx").on(t.swarmId, t.repoUrl)],
);

/**
 * A message sent into a swarm, with the same lifecycle a card message
 * has: queued until an agent hears it, sent when one is handed it,
 * delivered once its answer is on the transcript.
 *
 * A null taskId is a message to the planner, which is how a person
 * changes the plan rather than one leaf's work.
 */
export const swarmMessages = pgTable(
  "swarm_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
    /**
     * Denormalized from the owning project so row-level security can be a
     * column comparison rather than a join. Null means "belongs to no
     * organization", which is local mode. Set on insert; never changed.
     */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** Null means the planner: a message about the plan, not a leaf. */
    taskId: uuid("task_id").references(() => swarmTasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /**
     * Who wrote it. A continuation run started by this message acts with
     * the author's per-user MCP connections, so attribution here is what
     * keeps member B's follow-up from using member A's tokens.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status", { enum: ["queued", "sent", "delivered"] })
      .notNull()
      .default("queued"),
    /** The run that consumed this message; null while it waits. */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("swarm_messages_claim_idx").on(t.swarmId, t.taskId, t.status, t.createdAt)],
);
