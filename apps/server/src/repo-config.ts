import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { projects, repositories, type Db } from "@bento/db";
import { isWritableConfigBranch, parseRepoUrl, type GitHubRepositoryFiles } from "@bento/github";
import { parseAgentFile, writeAgentFile, type AgentFile } from "./agent-file.js";
import type { AppContext } from "./context.js";
import { isBetaRun } from "./feature-flags.js";
import { githubConnectionFor } from "./github.js";
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
 * Two rules hold throughout. A file that does not validate applies
 * nothing, and says why: the stages and agents a team has tuned are
 * never replaced by half a file. And files are read from the default
 * branch (or the checkout the person pointed at), never from a feature
 * branch, because feature branches are what agents write to and a
 * pipeline's `requirements` and `setup` are commands the server will
 * run.
 */

export const REPO_CONFIG_DIR = ".bento";
export const PIPELINE_FILE_PATH = `${REPO_CONFIG_DIR}/pipeline.yaml`;
export const AGENTS_FILE_PATH = `${REPO_CONFIG_DIR}/agents.yaml`;
export const REPO_CONFIG_PATHS = [PIPELINE_FILE_PATH, AGENTS_FILE_PATH] as const;

/** The queue a push to the default branch wakes. */
export const REPO_CONFIG_SYNC_QUEUE = "repo-config.sync";

/** A pipeline file is a few kilobytes; anything near this is not one. */
const MAX_FILE_BYTES = 1024 * 1024;

type RepositoryRow = typeof repositories.$inferSelect;

export interface RepoConfigSource {
  repository: { id: string; name: string };
  /** The text of each file, or null when the repository does not carry it. */
  pipeline: string | null;
  agents: string | null;
}

/**
 * The first repository, in workspace order, that carries either file.
 *
 * Null when none does. An error means the files could not be read at
 * all (a hosted project whose organization has no GitHub connection),
 * which is not the same as their absence and is never shown as it.
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
  if (!github) {
    return {
      error:
        "no GitHub connection is configured, so the repository's .bento files cannot be read. Install the GitHub App or save a GitHub token under Settings, GitHub.",
    };
  }
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
    const text = await readFile(file, "utf8");
    return text.length > MAX_FILE_BYTES ? null : text;
  } catch {
    // Missing, a directory, or unreadable: all of them mean "no file here".
    return null;
  }
}

/**
 * Hosted mode: the default branch on GitHub. Feature branches are what
 * agents push to, so a file on one of those is a file an agent chose.
 */
async function readFromGitHub(github: GitHubRepositoryFiles, repo: RepositoryRow): Promise<RepoConfigSource | null> {
  if (!repo.repoUrl) return null;
  const parsed = parseRepoUrl(repo.repoUrl);
  if (!parsed) return null;
  const at = (file: string) => github.readFile({ owner: parsed.owner, repo: parsed.repo, path: file, ref: repo.defaultBranch });
  const [pipeline, agents] = await Promise.all([at(PIPELINE_FILE_PATH), at(AGENTS_FILE_PATH)]);
  if (pipeline === null && agents === null) return null;
  return { repository: { id: repo.id, name: repo.name }, pipeline, agents };
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
 * Both files parsed and checked, or the first problem with the file
 * named. Either file may be absent; neither may be wrong.
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
    const parsed = parsePipelineFile(source.pipeline);
    if ("error" in parsed) return { error: `${PIPELINE_FILE_PATH}: ${parsed.error}` };
    pipeline = parsed.data;
  }
  return { pipeline, agents };
}

export type RepoConfigSyncResult =
  /** No repository carries either file. */
  | { status: "missing" }
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
      /** Agents from the agents file, when there was one. */
      agents: number | null;
    };

/**
 * Reads the repository's files and applies them to the project.
 *
 * Skipped when the files hash the same as the last ones applied, so
 * changes made in the console survive until the files themselves
 * change; `force` applies them anyway. Everything is written in one
 * transaction, agents file first and pipeline file second, and a
 * refusal anywhere rolls all of it back and is recorded on the project
 * so the console can show it.
 */
export async function syncRepoConfig(
  ctx: AppContext,
  database: Db,
  args: {
    projectId: string;
    owner: { ownerId: string; organizationId: string | null };
    force?: boolean;
  },
): Promise<RepoConfigSyncResult> {
  const [project] = await database.select().from(projects).where(eq(projects.id, args.projectId));
  if (!project) return { status: "missing" };
  const repos = await database
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));

  const source = await readRepoConfig(ctx, database, project, repos);
  if (source === null) return { status: "missing" };
  if ("error" in source) return { status: "unavailable", error: source.error };

  const hash = hashRepoConfig(source);
  if (!args.force && hash === project.repoConfigHash) {
    return { status: "unchanged", repository: source.repository };
  }

  const validated = validateRepoConfig(source);
  if ("error" in validated) {
    await database
      .update(projects)
      .set({ repoConfigError: validated.error, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    return { status: "invalid", error: validated.error, repository: source.repository };
  }

  class Refused extends Error {}
  let pipelineSummary: PipelineApplySummary | null = null;
  let agentCount: number | null = null;
  try {
    await database.transaction(async (tx) => {
      if (validated.agents) {
        const applied = await upsertAgentsFromFile(tx, validated.agents.agents, args.owner);
        if ("error" in applied) throw new Refused(`${AGENTS_FILE_PATH}: ${applied.error}`);
        agentCount = validated.agents.agents.length;
      }
      if (validated.pipeline) {
        const applied = await applyPipelineFile(tx, {
          projectId: project.id,
          file: validated.pipeline,
          owner: args.owner,
        });
        if (!applied.ok) throw new Refused(`${PIPELINE_FILE_PATH}: ${applied.error}`);
        pipelineSummary = applied.summary;
      }
      await tx
        .update(projects)
        .set({ repoConfigHash: hash, repoConfigSyncedAt: new Date(), repoConfigError: null, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    });
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    await database
      .update(projects)
      .set({ repoConfigError: err.message, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    return { status: "invalid", error: err.message, repository: source.repository };
  }

  const files: string[] = [];
  if (source.pipeline !== null) files.push(PIPELINE_FILE_PATH);
  if (source.agents !== null) files.push(AGENTS_FILE_PATH);
  return { status: "applied", repository: source.repository, files, pipeline: pipelineSummary, agents: agentCount };
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
  const [project] = await database.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const repos = await database
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));
  const source = await readRepoConfig(ctx, database, project, repos);
  const base = {
    paths: { pipeline: PIPELINE_FILE_PATH, agents: AGENTS_FILE_PATH },
    syncedAt: project.repoConfigSyncedAt?.toISOString() ?? null,
    error: project.repoConfigError,
  };
  if (source === null) {
    return { ...base, repository: null, found: { pipeline: false, agents: false }, changed: false, unavailable: null };
  }
  if ("error" in source) {
    return { ...base, repository: null, found: { pipeline: false, agents: false }, changed: false, unavailable: source.error };
  }
  return {
    ...base,
    repository: source.repository,
    found: { pipeline: source.pipeline !== null, agents: source.agents !== null },
    changed: hashRepoConfig(source) !== project.repoConfigHash,
    unavailable: null,
  };
}

export type RepoConfigPublishResult =
  | { ok: true; unchanged: true; repository: { id: string; name: string } }
  | { ok: true; unchanged: false; repository: { id: string; name: string }; branch: string; prNumber: number; url: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const GITHUB_NOT_CONNECTED =
  "no GitHub connection is configured. Save a GitHub token under Settings, GitHub, or install the GitHub App, then try again.";

/**
 * Commits the two files to a new branch and opens a pull request.
 *
 * Never to the default branch. The files land on a `bento/config-...`
 * branch and reach the trunk only when a person merges the pull
 * request; nothing here can write to main or master, and the GitHub
 * layer refuses such a request outright.
 *
 * The files are the export routes' own output, so what lands in the
 * repository is exactly what the Export buttons would have downloaded.
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
    owner: { ownerId: string; organizationId: string | null };
    /** Which checkout to commit to; the first one when omitted. */
    repositoryId?: string | null;
  },
): Promise<RepoConfigPublishResult> {
  const [project] = await database.select().from(projects).where(eq(projects.id, args.projectId));
  if (!project) return { ok: false, status: 404, error: "not found" };

  const github = await githubConnectionFor(ctx, project.organizationId, database);
  if (!github) return { ok: false, status: 409, error: GITHUB_NOT_CONNECTED };

  const selected = await database
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));
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
  const agentsYaml = writeAgentFile(await buildAgentFile(database, args.owner.ownerId));
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
  const at = (file: string) => github.readFile({ owner: parsed.owner, repo: parsed.repo, path: file, ref: repo.defaultBranch });
  const [currentPipeline, currentAgents] = await Promise.all([at(PIPELINE_FILE_PATH), at(AGENTS_FILE_PATH)]);
  if (currentPipeline === pipelineYaml && currentAgents === agentsYaml) {
    return { ok: true, unchanged: true, repository };
  }

  // Always a fresh branch of Bento's own, and never the default branch:
  // the files reach the trunk through the pull request and a person.
  // The GitHub layer refuses a trunk too; this is the same rule stated
  // where the branch is chosen.
  const branch = `bento/config-${timestampForBranch(new Date())}`;
  if (!isWritableConfigBranch(branch, repo.defaultBranch)) {
    return { ok: false, status: 409, error: `refusing to write to ${branch}: Bento never pushes to the default branch` };
  }
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

  await database
    .update(projects)
    .set({
      repoConfigHash: hashRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml }),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

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
 */
export async function queueRepoConfigSyncs(
  ctx: AppContext,
  database: Db,
  push: { owner: string; repo: string; branch: string; paths: Set<string> },
): Promise<number> {
  const rows = await database
    .select({ projectId: repositories.projectId, repoUrl: repositories.repoUrl, defaultBranch: repositories.defaultBranch })
    .from(repositories);
  const projectIds = new Set<string>();
  for (const row of rows) {
    if (!row.repoUrl) continue;
    const parsed = parseRepoUrl(row.repoUrl);
    if (!parsed || parsed.owner !== push.owner || parsed.repo !== push.repo) continue;
    if (!pushChangesRepoConfig(push, row.defaultBranch)) continue;
    projectIds.add(row.projectId);
  }
  for (const projectId of projectIds) {
    await ctx.boss.send(REPO_CONFIG_SYNC_QUEUE, { projectId });
  }
  return projectIds.size;
}

/**
 * The worker behind a push. Runs as the project's owner, the way an
 * auto-started stage does, and only for a board whose owner has the
 * feature: a push has no session to ask.
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
  const result = await syncRepoConfig(ctx, ctx.db, {
    projectId,
    owner: { ownerId: project.ownerId, organizationId: project.organizationId },
  });
  if (result.status === "invalid" || result.status === "unavailable") {
    console.warn(`${REPO_CONFIG_SYNC_QUEUE} ${projectId}: ${result.error}`);
  }
}
