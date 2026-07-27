import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asc, eq } from "drizzle-orm";
import { repositories } from "@bento/db";
import type { AppContext } from "./context.js";

const run = promisify(execFile);

/** Diffs larger than this are cut, with a note; the branch has the rest. */
const DIFF_CAP = 200_000;

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface StageArtifact {
  /** Path inside the repository, e.g. docs/bento/product-investigation.md */
  path: string;
  content: string;
}

export interface RepositoryChanges {
  name: string;
  branch: string;
  files: ChangedFile[];
  /** Unified diff against the branch point, possibly truncated. */
  diff: string;
  truncated: boolean;
  artifacts: StageArtifact[];
}

/**
 * What a card's agents have produced so far, read from git rather than
 * the sandbox: the worktree may be gone (a runner's machine, a swept
 * workspace) but the feature branch in the source repository has every
 * commit, and the stage write-ups under docs/bento/ ride along in it.
 *
 * A repository the branch never touched reports nothing rather than an
 * error, so a card spanning three repos where the agent changed one
 * reads as exactly that.
 */
export async function collectFeatureChanges(
  ctx: AppContext,
  projectId: string,
  branch: string | null,
): Promise<RepositoryChanges[]> {
  if (!branch) return [];
  const repos = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(asc(repositories.position));

  const out: RepositoryChanges[] = [];
  for (const repo of repos) {
    const git = (...args: string[]) => run("git", ["-C", repo.localPath, ...args]);
    try {
      await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      continue; // No branch here: the agent never touched this repository.
    }
    // The card's changes are what happened ON its branch, so the base
    // is the fork point. The default branch's merge-base is not enough:
    // a feature branched from a checkout sitting on unmerged work would
    // count all of that work as the card's. The newest merge-base
    // across every local branch is the actual divergence point.
    const base = await forkPoint(git, branch, repo.defaultBranch || "main");

    const numstat = await git("diff", "--numstat", `${base}..${branch}`, "--");
    const files: ChangedFile[] = numstat.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [a, d, ...rest] = line.split("\t");
        return {
          path: rest.join("\t"),
          additions: Number.parseInt(a ?? "0", 10) || 0,
          deletions: Number.parseInt(d ?? "0", 10) || 0,
        };
      });
    if (files.length === 0) continue;

    const diffOut = await git("diff", `${base}..${branch}`, "--");
    const truncated = diffOut.stdout.length > DIFF_CAP;
    const diff = truncated ? diffOut.stdout.slice(0, DIFF_CAP) : diffOut.stdout;

    const artifactList = await git("ls-tree", "-r", "--name-only", branch, "--", "docs/bento/");
    const artifacts: StageArtifact[] = [];
    for (const path of artifactList.stdout.split("\n").filter(Boolean)) {
      const { stdout } = await git("show", `${branch}:${path}`);
      artifacts.push({ path, content: stdout });
    }

    out.push({ name: repo.name, branch, files, diff, truncated, artifacts });
  }
  return out;
}

type Git = (...args: string[]) => Promise<{ stdout: string }>;

/** The newest commit the branch shares with any other local branch. */
async function forkPoint(git: Git, branch: string, defaultBranch: string): Promise<string> {
  const { stdout } = await git("for-each-ref", "refs/heads", "--format=%(refname:short)");
  const others = stdout.split("\n").filter((ref) => ref && ref !== branch);
  let best: string | null = null;
  for (const ref of others) {
    let candidate: string;
    try {
      candidate = (await git("merge-base", ref, branch)).stdout.trim();
    } catch {
      continue; // No shared history with this ref.
    }
    if (!best) {
      best = candidate;
      continue;
    }
    try {
      await git("merge-base", "--is-ancestor", best, candidate);
      best = candidate; // The candidate is newer along the branch.
    } catch {
      // best stays: candidate is older or unrelated.
    }
  }
  if (best) return best;
  try {
    return (await git("merge-base", defaultBranch, branch)).stdout.trim();
  } catch {
    return `${branch}~0`; // No common history anywhere; diff the branch alone.
  }
}
