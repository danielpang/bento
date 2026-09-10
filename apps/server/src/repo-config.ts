import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { projects, repositories, type Db } from "@bento/db";
import { parseRepoUrl, type GitHubRepositoryFiles } from "@bento/github";
import { parseAgentFile, writeAgentFile, type AgentFile } from "./agent-file.js";
import type { AppContext } from "./context.js";
import { isBetaRun } from "./feature-flags.js";
import { GITHUB_NOT_CONNECTED, githubConnectionFor } from "./github.js";
import { linkGitHubRemotes } from "./orchestrator/repo-remote.js";
import { applyPipelineFile, type PipelineApplySummary } from "./pipeline-apply.js";
import { buildAgentFile, buildPipelineFile } from "./pipeline-export.js";
import { parsePipelineFile, writePipelineFile, type PipelineFile } from "./pipeline-file.js";
import { upsertAgentsFromFile } from "./upsert-agents.js";

/**
 * Bento's configuration, kept in the repository it describes.
 *
 * The pipeline file and the agents file already exist as exports. This
 * lets them live at a fixed place in the checkout, `.bento/`, where
 * Bento reads them back: when a project is created from the
 * repository, when a push changes them on the default branch, and when
 * a person asks. The same board then follows the code to another
 * computer, another install, or from a local Bento to the hosted one.
 *
 * Three rules hold throughout. A file that does not validate applies
 * nothing, and says why: the stages and agents a team has tuned are
 * never replaced by half a file. Files are read from the default
 * branch (or the checkout the person pointed at), never from a feature
 * branch, because feature branches are what agents write to and a
 * pipeline's `requirements` and `setup` are commands the server will
 * run. And everything repository-driven acts as the project's owner,
 * whoever pressed the button: agents are matched by name within one
 * person's roster, and a file applied by two people in turn would
 * otherwise create the same agent twice and flip every stage between
 * the copies.
 */

export const REPO_CONFIG_DIR = ".bento";
export const PIPELINE_FILE_PATH = `${REPO_CONFIG_DIR}/pipeline.yaml`;
export const AGENTS_FILE_PATH = `${REPO_CONFIG_DIR}/agents.yaml`;
export const REPO_CONFIG_PATHS = [PIPELINE_FILE_PATH, AGENTS_FILE_PATH] as const;

/** The queue a push to the default branch wakes. */
export const REPO_CONFIG_SYNC_QUEUE = "repo-config.sync";

/** A pipeline file is a few kilobytes; anything near this is not one. */
const MAX_FILE_BYTES = 1024 * 1024;

type ProjectRow = typeof projects.$inferSelect;
type RepositoryRow = typeof repositories.$inferSelect;

export interface RepoConfigSource {
  repository: { id: string; name: string };
  /** The text of each file, or null when the repository does not carry it. */
  pipeline: string | null;
  agents: string | null;
}

/** The project and its checkouts in workspace order, or null when there is no such project. */
async function loadProjectRepositories(
  database: Db,
  projectId: string,
): Promise<{ project: ProjectRow; repos: RepositoryRow[] } | null> {
  const [project] = await database.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const repos = await database
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));
  return { project, repos };
}

/**
 * The first repository, in workspace order, that carries either file.
 *
 * Null when none does. An error means the files could not be read at
 * all (no GitHub connection, a revoked token, a rate limit), which is
 * not the same as their absence and is never shown as it.
 */
export async function readRepoConfig(
  ctx: AppContext,
  database: Db,
  project: { organizationId: string | null },
  repos: RepositoryRow[],
): Promise<RepoConfigSource | { error: string } | null> {
  if (repos.length === 0) return null;
  if (ctx.env.BENTO_MODE !== "multi") {
    for (const repo of repos) {
      const source = await readFromCheckout(repo);
      if (source) return source;
    }
    return null;
  }

  const github = await githubConnectionFor(ctx, project.organizationId, database);
  if (!github) return { error: `the repository's .bento files cannot be read: ${GITHUB_NOT_CONNECTED}` };
  for (const repo of repos) {
    const source = await readFromGitHub(github, repo);
    if (source) return source;
  }
  return null;
}

/** Local mode: the checkout the person pointed at, as it is on disk. */
async function readFromCheckout(repo: RepositoryRow): Promise<RepoConfigSource | null> {
  const [pipeline, agents] = await Promise.all([
    readLocalFile(path.join(repo.localPath, PIPELINE_FILE_PATH)),
    readLocalFile(path.join(repo.localPath, AGENTS_FILE_PATH)),
  ]);
  if (pipeline === null && agents === null) return null;
  return { repository: { id: repo.id, name: repo.name }, pipeline, agents };
}

async function readLocalFile(file: string): Promise<string | null> {
  try {
    // Size first, so a file that is not a config file at all is never
    // pulled into memory to find that out.
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    // Missing, a directory, or unreadable: all of them mean "no file here".
    return null;
  }
}

/**
 * Hosted mode: the default branch on GitHub. Feature branches are what
 * agents push to, so a file on one of those is a file an agent chose.
 *
 * Shared with publish, which compares the board against these same two
 * reads before deciding whether a pull request has anything to say.
 * Only a missing file is null; a GitHub refusal (revoked token, missing
 * permission, rate limit) is reported as such rather than treated as
 * "no file here", which would read as a board with nothing in it.
 */
async function readFromGitHub(
  github: GitHubRepositoryFiles,
  repo: RepositoryRow,
): Promise<RepoConfigSource | { error: string } | null> {
  if (!repo.repoUrl) return null;
  const parsed = parseRepoUrl(repo.repoUrl);
  if (!parsed) return null;
  try {
    const { pipeline, agents } = await readGitHubConfigFiles(github, parsed, repo.defaultBranch);
    if (pipeline === null && agents === null) return null;
    return { repository: { id: repo.id, name: repo.name }, pipeline, agents };
  } catch (err) {
    return {
      error: `GitHub would not return the .bento files of ${parsed.owner}/${parsed.repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function readGitHubConfigFiles(
  github: GitHubRepositoryFiles,
  parsed: { owner: string; repo: string },
  ref: string,
): Promise<{ pipeline: string | null; agents: string | null }> {
  const at = (file: string) => github.readFile({ owner: parsed.owner, repo: parsed.repo, path: file, ref });
  const [pipeline, agents] = await Promise.all([at(PIPELINE_FILE_PATH), at(AGENTS_FILE_PATH)]);
  return { pipeline, agents };
}

/** A digest of both texts, so an unchanged pair is recognised as such. */
export function hashRepoConfig(source: { pipeline: string | null; agents: string | null }): string {
  return createHash("sha256")
    .update(source.pipeline ?? "")
    .update("\0")
    .update(source.agents ?? "")
    .digest("hex");
}

/**
 * Both files parsed and checked as a pair, or the first problem with the
 * file named. Either file may be absent; neither may be wrong.
 *
 * A stage may name an agent defined in either file. The pipeline file
 * on its own insists on defining every agent it names, because an
 * import has nothing else to look in; here the agents file is the
 * other place, so the check is made against both.
 */
export function validateRepoConfig(
  source: { pipeline: string | null; agents: string | null },
): { pipeline: PipelineFile | null; agents: AgentFile | null } | { error: string } {
  let pipeline: PipelineFile | null = null;
  let agents: AgentFile | null = null;
  if (source.agents !== null) {
    const parsed = parseAgentFile(source.agents);
    if ("error" in parsed) return { error: `${AGENTS_FILE_PATH}: ${parsed.error}` };
    agents = parsed.data;
  }
  if (source.pipeline !== null) {
    const parsed = parsePipelineFile(source.pipeline, {
      knownAgents: agents?.agents.map((agent) => agent.name) ?? [],
    });
    if ("error" in parsed) return { error: `${PIPELINE_FILE_PATH}: ${parsed.error}` };
    pipeline = parsed.data;
  }
  return { pipeline, agents };
}

/** The distinct agent names the pair defines, which is what "n agents" counts. */
function agentNamesIn(validated: { pipeline: PipelineFile | null; agents: AgentFile | null }): Set<string> {
  const names = new Set<string>();
  for (const agent of validated.pipeline?.agents ?? []) names.add(agent.name);
  for (const agent of validated.agents?.agents ?? []) names.add(agent.name);
  return names;
}

export type RepoConfigSyncResult =
  /** No repository carries either file. */
  | { status: "missing"; error: string }
  /** The files could not be read; the message says why. */
  | { status: "unavailable"; error: string }
  /** The files are the ones already applied, so nothing was touched. */
  | { status: "unchanged"; repository: { id: string; name: string } }
  /** The files did not validate, or would strand cards; nothing was touched. */
  | { status: "invalid"; error: string; repository: { id: string; name: string } }
  | {
      status: "applied";
      repository: { id: string; name: string };
      files: string[];
      pipeline: PipelineApplySummary | null;
      /** Distinct agents the pair defined, whichever file each came from. */
      agents: number;
    };

const MISSING = `no repository in this project has a ${PIPELINE_FILE_PATH} or ${AGENTS_FILE_PATH}`;

/**
 * What one sync concluded, written to the project as a whole.
 *
 * Every outcome writes every column, so no outcome can leave another's
 * state behind: files removed clear the hash and the error, files that
 * match clear an error from a bad push since reverted, and a refusal
 * keeps the hash of what is still actually applied.
 */
async function recordRepoConfigState(
  database: Db,
  projectId: string,
  outcome: { hash: string | null; syncedAt?: Date; error: string | null },
): Promise<void> {
  await database
    .update(projects)
    .set({
      repoConfigHash: outcome.hash,
      ...(outcome.syncedAt ? { repoConfigSyncedAt: outcome.syncedAt } : {}),
      repoConfigError: outcome.error,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
}

/** Carries a refusal out of the apply transaction so it rolls back. */
class Refused extends Error {}

/**
 * Reads the repository's files and applies them to the project.
 *
 * Skipped when the files hash the same as the last ones applied, so
 * changes made in the console survive until the files themselves
 * change; `force` applies them anyway. Everything is written in one
 * transaction, pipeline file first and agents file second, so the agents
 * file is the definition that wins when both describe an agent. A
 * refusal anywhere rolls all of it back and is recorded on the project
 * so the console can show it.
 *
 * Acts as the project's owner: see the module comment.
 */
export async function syncRepoConfig(
  ctx: AppContext,
  database: Db,
  args: { projectId: string; force?: boolean },
): Promise<RepoConfigSyncResult> {
  const loaded = await loadProjectRepositories(database, args.projectId);
  if (!loaded) return { status: "missing", error: MISSING };
  const { project, repos } = loaded;
  const owner = { ownerId: project.ownerId, organizationId: project.organizationId };

  const source = await readRepoConfig(ctx, database, project, repos);
  if (source === null) {
    if (project.repoConfigHash || project.repoConfigError) {
      await recordRepoConfigState(database, project.id, { hash: null, error: null });
    }
    return { status: "missing", error: MISSING };
  }
  if ("error" in source) return { status: "unavailable", error: source.error };

  const hash = hashRepoConfig(source);
  if (!args.force && hash === project.repoConfigHash) {
    if (project.repoConfigError) await recordRepoConfigState(database, project.id, { hash, error: null });
    return { status: "unchanged", repository: source.repository };
  }

  const validated = validateRepoConfig(source);
  if ("error" in validated) {
    await recordRepoConfigState(database, project.id, { hash: project.repoConfigHash, error: validated.error });
    return { status: "invalid", error: validated.error, repository: source.repository };
  }

  let pipelineSummary: PipelineApplySummary | null = null;
  try {
    await database.transaction(async (tx) => {
      if (validated.pipeline) {
        const applied = await applyPipelineFile(tx, { projectId: project.id, file: validated.pipeline, owner });
        if (!applied.ok) throw new Refused(`${PIPELINE_FILE_PATH}: ${applied.error}`);
        pipelineSummary = applied.summary;
      }
      if (validated.agents) {
        const applied = await upsertAgentsFromFile(tx, validated.agents.agents, owner);
        if ("error" in applied) throw new Refused(`${AGENTS_FILE_PATH}: ${applied.error}`);
      }
      await recordRepoConfigState(tx, project.id, { hash, syncedAt: new Date(), error: null });
    });
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    await recordRepoConfigState(database, project.id, { hash: project.repoConfigHash, error: err.message });
    return { status: "invalid", error: err.message, repository: source.repository };
  }

  const files: string[] = [];
  if (source.pipeline !== null) files.push(PIPELINE_FILE_PATH);
  if (source.agents !== null) files.push(AGENTS_FILE_PATH);
  return {
    status: "applied",
    repository: source.repository,
    files,
    pipeline: pipelineSummary,
    agents: agentNamesIn(validated).size,
  };
}

export interface RepoConfigStatus {
  paths: { pipeline: string; agents: string };
  /** The repository the files were found in, or null when none carries them. */
  repository: { id: string; name: string } | null;
  found: { pipeline: boolean; agents: boolean };
  /** True when the files differ from the ones last applied. */
  changed: boolean;
  syncedAt: string | null;
  /** Why the last sync applied nothing, or null. */
  error: string | null;
  /** Set when the files could not be read at all. */
  unavailable: string | null;
}

/** What the console shows beside the Sync button. Reads, never writes. */
export async function describeRepoConfig(
  ctx: AppContext,
  database: Db,
  projectId: string,
): Promise<RepoConfigStatus | null> {
  const loaded = await loadProjectRepositories(database, projectId);
  if (!loaded) return null;
  const { project, repos } = loaded;
  const source = await readRepoConfig(ctx, database, project, repos);
  const found = source && !("error" in source) ? source : null;
  return {
    paths: { pipeline: PIPELINE_FILE_PATH, agents: AGENTS_FILE_PATH },
    syncedAt: project.repoConfigSyncedAt?.toISOString() ?? null,
    error: project.repoConfigError,
    repository: found?.repository ?? null,
    found: { pipeline: found?.pipeline != null, agents: found?.agents != null },
    changed: found ? hashRepoConfig(found) !== project.repoConfigHash : false,
    unavailable: source && "error" in source ? source.error : null,
  };
}

export type RepoConfigPublishResult =
  | { ok: true; unchanged: true; repository: { id: string; name: string } }
  | { ok: true; unchanged: false; repository: { id: string; name: string }; branch: string; prNumber: number; url: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Commits the two files to a new branch and opens a pull request.
 *
 * Never to the default branch. The files land on a `bento/config-...`
 * branch and reach the trunk only when a person merges the pull
 * request; the GitHub layer only ever creates a new ref and refuses a
 * trunk by name, so nothing here can write to main or master.
 *
 * The files are the export routes' own output for the project's owner,
 * so what lands in the repository is exactly what the Export buttons
 * would have downloaded from the owner's account, whoever pressed this.
 * The commit is made on the trusted host with the server's GitHub
 * credential, the same one that publishes feature branches, and never
 * from inside a sandbox.
 *
 * Nothing is opened when the default branch already carries these
 * exact files: a pull request with an empty diff is noise. The hash of
 * what was published is recorded as applied, so merging the pull
 * request unchanged does not turn around and re-import it over edits
 * made in the meantime.
 */
export async function publishRepoConfig(
  ctx: AppContext,
  database: Db,
  args: {
    projectId: string;
    /** Which checkout to commit to; the first one when omitted. */
    repositoryId?: string | null;
  },
): Promise<RepoConfigPublishResult> {
  const loaded = await loadProjectRepositories(database, args.projectId);
  if (!loaded) return { ok: false, status: 404, error: "not found" };
  const { project, repos: selected } = loaded;

  const github = await githubConnectionFor(ctx, project.organizationId, database);
  if (!github) return { ok: false, status: 409, error: GITHUB_NOT_CONNECTED };
  if (selected.length === 0) {
    return { ok: false, status: 409, error: "the project has no repositories, so there is nowhere to commit the files" };
  }
  // Repositories added by path before their remote was read still have
  // no URL. Reading it here means an older project publishes rather
  // than refusing for a link its checkout has always had.
  const repos = ctx.env.BENTO_MODE === "multi" ? selected : await linkGitHubRemotes(database, selected);
  const repo = args.repositoryId ? repos.find((row) => row.id === args.repositoryId) : repos[0];
  if (!repo) return { ok: false, status: 404, error: "not found" };
  if (!repo.repoUrl) {
    return {
      ok: false,
      status: 409,
      error: `the ${repo.name} checkout has no GitHub remote, so there is nowhere to open the pull request. Add one with git remote add origin, then try again.`,
    };
  }
  const parsed = parseRepoUrl(repo.repoUrl);
  if (!parsed) return { ok: false, status: 409, error: `not a GitHub remote: ${repo.repoUrl}` };

  const built = await buildPipelineFile(database, project.id);
  if (!built) return { ok: false, status: 404, error: "not found" };
  if ("error" in built) return { ok: false, status: 400, error: built.error };
  const pipelineYaml = writePipelineFile(built.file);
  const agentsYaml = writeAgentFile(await buildAgentFile(database, project.ownerId));
  // The point of the files is to be read back, so a pair the sync would
  // refuse is refused here, before it reaches anyone's repository. The
  // export routes deliberately skip this check (a roster too big for the
  // format must still be able to leave), but a pull request that can
  // never be applied is a worse outcome than no pull request.
  const readable = validateRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml });
  if ("error" in readable) {
    return {
      ok: false,
      status: 400,
      error: `these files would be refused when Bento reads them back: ${readable.error}. Fix that first, then publish again.`,
    };
  }

  const repository = { id: repo.id, name: repo.name };
  const current = await readGitHubConfigFiles(github, parsed, repo.defaultBranch);
  if (current.pipeline === pipelineYaml && current.agents === agentsYaml) {
    return { ok: true, unchanged: true, repository };
  }

  const branch = `bento/config-${timestampForBranch(new Date())}`;
  await github.commitFiles({
    owner: parsed.owner,
    repo: parsed.repo,
    baseBranch: repo.defaultBranch,
    branch,
    message: "Add the Bento pipeline and agents",
    files: [
      { path: PIPELINE_FILE_PATH, content: pipelineYaml },
      { path: AGENTS_FILE_PATH, content: agentsYaml },
    ],
  });
  const pr = await github.ensurePullRequest({
    owner: parsed.owner,
    repo: parsed.repo,
    head: branch,
    base: repo.defaultBranch,
    title: "Add the Bento pipeline and agents",
    body: pullRequestBody(project.name, repo.defaultBranch),
  });

  await recordRepoConfigState(database, project.id, {
    hash: hashRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml }),
    syncedAt: new Date(),
    error: null,
  });

  return { ok: true, unchanged: false, repository, branch, prNumber: pr.prNumber, url: pr.url };
}

function pullRequestBody(projectName: string, defaultBranch: string): string {
  return [
    `The Bento pipeline and agents behind the "${projectName}" board, as files.`,
    "",
    `- \`${PIPELINE_FILE_PATH}\`: the stages, what each one requires before a card advances, the agent that runs it, and each repository's setup and test commands.`,
    `- \`${AGENTS_FILE_PATH}\`: every named agent, with its tool, model, and skill.`,
    "",
    `Bento reads these files when a project is created from this repository, and again whenever they change on \`${defaultBranch}\`, so the same board follows the code to another computer or another Bento install. A file that does not validate is refused whole and the board is left as it was.`,
    "",
    `Opened by Bento. Bento only ever commits these files to a branch of its own and leaves merging to you; it never pushes to \`${defaultBranch}\`.`,
  ].join("\n");
}

/** 20260910-142233: sortable, unambiguous, and legal in a branch name. */
function timestampForBranch(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * Whether a push should make a project re-read its files: it landed on
 * the repository's default branch and touched the `.bento` directory.
 */
export function pushChangesRepoConfig(push: { branch: string; paths: Set<string> }, defaultBranch: string): boolean {
  if (push.branch !== defaultBranch) return false;
  return REPO_CONFIG_PATHS.some((file) => push.paths.has(file));
}

/**
 * Queues a sync for every project whose repository the push touched.
 * Called from the webhook, which answers GitHub at once; the work
 * itself runs on the queue.
 *
 * Almost every push is an agent's feature branch, so the path check
 * comes before any query: a push that did not touch `.bento/` costs
 * nothing. A burst of pushes collapses to one job per project, because
 * every job after the first would read the same files and find them
 * already applied.
 */
export async function queueRepoConfigSyncs(
  ctx: AppContext,
  database: Db,
  push: { owner: string; repo: string; branch: string; paths: Set<string> },
): Promise<number> {
  if (!REPO_CONFIG_PATHS.some((file) => push.paths.has(file))) return 0;
  const rows = await database
    .select({ projectId: repositories.projectId, repoUrl: repositories.repoUrl, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.defaultBranch, push.branch));
  const projectIds = new Set<string>();
  for (const row of rows) {
    if (!row.repoUrl) continue;
    const parsed = parseRepoUrl(row.repoUrl);
    if (!parsed || parsed.owner !== push.owner || parsed.repo !== push.repo) continue;
    if (!pushChangesRepoConfig(push, row.defaultBranch)) continue;
    projectIds.add(row.projectId);
  }
  for (const projectId of projectIds) {
    await ctx.boss.send(REPO_CONFIG_SYNC_QUEUE, { projectId }, { singletonKey: projectId, singletonSeconds: 30 });
  }
  return projectIds.size;
}

/**
 * The worker behind a push. Runs for a board whose owner has the
 * feature, the way an auto-started stage does: a push has no session
 * to ask.
 */
export async function registerRepoConfigJobs(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue(REPO_CONFIG_SYNC_QUEUE);
  await ctx.boss.work<{ projectId: string }>(REPO_CONFIG_SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        await syncRepoConfigForProject(ctx, job.data.projectId);
      } catch (err) {
        console.error(`${REPO_CONFIG_SYNC_QUEUE} ${job.data.projectId} failed:`, err);
        ctx.analytics?.captureException(err, null, null, { queue: REPO_CONFIG_SYNC_QUEUE, project_id: job.data.projectId });
        throw err;
      }
    }
  });
}

async function syncRepoConfigForProject(ctx: AppContext, projectId: string): Promise<void> {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return;
  if (!(await isBetaRun(ctx, { actingUserId: null, projectOwnerId: project.ownerId }))) return;
  const result = await syncRepoConfig(ctx, ctx.db, { projectId });
  if (result.status === "invalid" || result.status === "unavailable") {
    console.warn(`${REPO_CONFIG_SYNC_QUEUE} ${projectId}: ${result.error}`);
  }
}
