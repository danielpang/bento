import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { stageArtifactPath, WORKSPACE_ARTIFACT_DIR } from "@bento/core";
import { runArtifacts } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";

/**
 * Pulls what an agent produced for people out of the sandbox when its
 * run succeeds, and keeps it as run_artifacts rows. Failed runs skip
 * capture on purpose: their sandboxes are often unusable (a missing
 * CLI, dead credentials), and half-finished files presented as the
 * stage's output would mislead the person reviewing the card.
 *
 * Two sources. The stage write-up at docs/bento/<slug>.md is committed
 * to git, but reading it back through git only works for branches that
 * reached the host; a sprite whose branch was never pushed kept its
 * write-up invisible. Reading it out of the sandbox here works the same
 * for every driver. The workspace-level artifacts/ directory is for
 * everything that does not belong in the repository: mockups,
 * screenshots, HTML previews, diagrams. The prompt names it.
 *
 * Everything goes through driver.exec and portable shell (find, wc,
 * base64), so sprites, docker, and the local driver need no per-driver
 * code. Capture failing must never fail the run: the work is already
 * done, and a note in the transcript beats a red card.
 */

/** One oversized screencast must not become a surprise storage bill. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** An agent that wrote 300 files did not write 300 things worth keeping. */
export const MAX_ARTIFACTS_PER_RUN = 20;
/** Text this small stays in Postgres, where it is queryable and transactional. */
const INLINE_CAP_BYTES = 1024 * 1024;
const EXEC_TIMEOUT_MS = 60_000;

export type ArtifactKind = "markdown" | "mermaid" | "image" | "html" | "file";

interface Classified {
  kind: ArtifactKind;
  mime: string;
  /** Text renders inline from Postgres; binary goes to the store. */
  text: boolean;
}

/**
 * By extension rather than by sniffing: the kind only picks a viewer,
 * and the viewer treats every artifact as untrusted whatever it is
 * called. SVG is deliberately "file", not "image": it can carry script,
 * so it is offered as a download rather than ever rendered.
 */
export function classifyArtifact(path: string): Classified {
  const ext = (/\.[A-Za-z0-9]+$/.exec(path)?.[0] ?? "").toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return { kind: "markdown", mime: "text/markdown", text: true };
    case ".mmd":
    case ".mermaid":
      return { kind: "mermaid", mime: "text/plain", text: true };
    case ".html":
    case ".htm":
      return { kind: "html", mime: "text/html", text: true };
    case ".png":
      return { kind: "image", mime: "image/png", text: false };
    case ".jpg":
    case ".jpeg":
      return { kind: "image", mime: "image/jpeg", text: false };
    case ".gif":
      return { kind: "image", mime: "image/gif", text: false };
    case ".webp":
      return { kind: "image", mime: "image/webp", text: false };
    case ".txt":
      return { kind: "file", mime: "text/plain", text: true };
    default:
      return { kind: "file", mime: "application/octet-stream", text: false };
  }
}

/**
 * Which rows an artifact belongs to: a card, or a swarm and the node of
 * its plan that produced it. Exactly one, the way run_artifacts states
 * it.
 */
export type ArtifactOwner =
  | { featureId: string }
  | { swarmId: string; swarmTaskId?: string | null };

/** The store key for one artifact. Org-prefixed for lifecycle bookkeeping only. */
export function artifactStorageKey(
  organizationId: string | null,
  owner: ArtifactOwner,
  runId: string,
  artifactId: string,
): string {
  const scope = "featureId" in owner ? `feature/${owner.featureId}` : `swarm/${owner.swarmId}`;
  return `org/${organizationId ?? "local"}/${scope}/run/${runId}/${artifactId}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface CaptureArgs {
  runId: string;
  /** The card, or the swarm and its node. See ArtifactOwner. */
  owner: ArtifactOwner;
  organizationId: string | null;
  stageSlug: string;
  stageName: string;
  handle: SandboxHandle;
  repositories: { name: string; mountPath: string }[];
  /** Writes a system line into the run transcript. */
  say: (text: string) => Promise<void>;
}

export async function captureRunArtifacts(ctx: AppContext, args: CaptureArgs): Promise<void> {
  try {
    await capture(ctx, args);
  } catch (err) {
    // The run's work is done and recorded; losing its attachments is
    // worth a line, not a failure.
    console.error(`artifact capture failed for run ${args.runId}:`, err);
    ctx.analytics?.captureException(err, null, args.organizationId, {
      run_id: args.runId,
      ...("featureId" in args.owner
        ? { feature_id: args.owner.featureId }
        : { swarm_id: args.owner.swarmId }),
      source: "artifact_capture",
    });
    await args.say(`Could not save this run's artifacts: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
}

async function capture(ctx: AppContext, args: CaptureArgs): Promise<void> {
  const sh = async (script: string) =>
    collectExec(ctx.driver.exec(args.handle, ["sh", "-c", script], { timeoutMs: EXEC_TIMEOUT_MS }));

  /**
   * Candidate files, write-ups first so the cap lands on extras rather
   * than on the one file every stage is asked to produce. The display
   * path names the repository only when there are several, matching how
   * the rest of the console talks about a single-repo project.
   */
  const writeUp = stageArtifactPath(args.stageSlug);
  const candidates: { abs: string; display: string; fromArtifactDir: boolean }[] = args.repositories.map((repo) => ({
    abs: `${repo.mountPath}/${writeUp}`,
    display: args.repositories.length > 1 ? `${repo.name}/${writeUp}` : writeUp,
    fromArtifactDir: false,
  }));

  const artifactDir = `${args.handle.workdir}/${WORKSPACE_ARTIFACT_DIR}`;
  // The routes reserve the directory's name, but a repository row
  // created before they did could still check out here; nothing under
  // a .git is ever an artifact, and capture deletes what it keeps.
  const listing = await sh(
    `[ -d ${shellQuote(artifactDir)} ] || exit 0; find ${shellQuote(artifactDir)} -type f -not -path '*/.git/*' | sort`,
  );
  const listed = listing.exitCode === 0
    ? listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  for (const abs of listed) {
    // A path with a newline in its name arrives here as two garbage
    // lines; both fail the -f probe below and are skipped.
    candidates.push({
      abs,
      display: `${WORKSPACE_ARTIFACT_DIR}/${abs.slice(artifactDir.length + 1)}`,
      fromArtifactDir: true,
    });
  }

  const overflow = candidates.length - MAX_ARTIFACTS_PER_RUN;
  if (overflow > 0) {
    candidates.length = MAX_ARTIFACTS_PER_RUN;
    await args.say(
      `This run produced more than ${MAX_ARTIFACTS_PER_RUN} artifacts; the ${overflow} beyond that were left in the sandbox.`,
    );
  }

  const kept: string[] = [];
  const captured: { abs: string }[] = [];
  for (const candidate of candidates) {
    /**
     * Size first, bytes only when they fit: one exec answers both, with
     * the size on the first line so an oversized file costs its length,
     * not its content. Exit 3 tells "absent" apart from a real failure,
     * because a missing write-up is normal and a broken exec is not.
     */
    // base64 reads stdin, not an argument: BSD base64 (the local driver
    // on a Mac) has no positional file form, and stdin works everywhere.
    const probe = await sh(
      `f=${shellQuote(candidate.abs)}; [ -f "$f" ] || exit 3; wc -c < "$f"; ` +
        `if [ "$(wc -c < "$f")" -le ${MAX_ARTIFACT_BYTES} ]; then base64 < "$f"; fi`,
    );
    if (probe.exitCode === 3) continue;
    if (probe.exitCode !== 0) {
      await args.say(`Could not read ${candidate.display} from the sandbox, so it was not saved.`);
      continue;
    }
    const newline = probe.stdout.indexOf("\n");
    const size = Number((newline === -1 ? probe.stdout : probe.stdout.slice(0, newline)).trim());
    if (!Number.isSafeInteger(size)) continue;
    if (size > MAX_ARTIFACT_BYTES) {
      await args.say(
        `${candidate.display} is ${Math.round(size / 1024 / 1024)} MB, over the ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB artifact limit, so it was left in the sandbox.`,
      );
      continue;
    }
    const data = Buffer.from(probe.stdout.slice(newline + 1).replaceAll(/\s+/g, ""), "base64");

    /**
     * A judge or resume run on this stage reads back the same write-up;
     * unchanged content is already on the card, and a second identical
     * row would only push the real artifacts down the list.
     */
    const [latest] = await ctx.db
      .select({ content: runArtifacts.content, size: runArtifacts.size })
      .from(runArtifacts)
      .where(and(ownerFilter(args.owner), eq(runArtifacts.path, candidate.display)))
      .orderBy(desc(runArtifacts.createdAt))
      .limit(1);
    if (
      latest &&
      latest.content !== null &&
      latest.size === data.byteLength &&
      latest.content === data.toString("utf8")
    ) {
      // Already on the card, so the file still leaves the artifacts
      // directory below; leaving it meant re-reading it on every
      // later run of this sandbox, forever.
      if (candidate.fromArtifactDir) captured.push({ abs: candidate.abs });
      continue;
    }

    const classified = classifyArtifact(candidate.display);
    const id = randomUUID();
    const inline = classified.text && data.byteLength <= INLINE_CAP_BYTES;
    let storageKey: string | null = null;
    if (!inline) {
      if (!ctx.artifacts) {
        await args.say(
          `${candidate.display} was not saved: this deployment has no artifact storage configured for binary files.`,
        );
        continue;
      }
      storageKey = artifactStorageKey(args.organizationId, args.owner, args.runId, id);
      await ctx.artifacts.put(storageKey, data, classified.mime);
    }

    // organization_id is left to the insert trigger, which derives it
    // from the run the same way run_events rows get theirs.
    await ctx.db.insert(runArtifacts).values({
      id,
      runId: args.runId,
      // Which board, said outright rather than left to be read off the
      // ids below. The owner is the one thing here that knows.
      type: "featureId" in args.owner ? "pipeline" : "swarm",
      ...args.owner,
      stageSlug: args.stageSlug,
      stageName: args.stageName,
      path: candidate.display,
      kind: classified.kind,
      mime: classified.mime,
      size: data.byteLength,
      content: inline ? data.toString("utf8") : null,
      storageKey,
    });
    kept.push(candidate.display);
    if (candidate.fromArtifactDir) captured.push({ abs: candidate.abs });
  }

  /**
   * Captured files leave the artifacts directory, or the next stage's
   * run on this sandbox would capture them again as its own. Write-ups
   * stay where they are: they are committed, and later stages are told
   * to read them.
   */
  if (captured.length > 0) {
    await sh(`rm -f ${captured.map((f) => shellQuote(f.abs)).join(" ")}`).catch(() => {});
  }

  if (kept.length > 0) {
    const named = kept.slice(0, 5).join(", ");
    await args.say(
      `Kept ${kept.length} artifact${kept.length === 1 ? "" : "s"} from this run: ${named}${kept.length > 5 ? ", ..." : ""}. They are on the card under Artifacts.`,
    );
  }
}

/**
 * "This card's artifacts", or "this leaf's", as a WHERE clause.
 *
 * A swarm is many agents producing files at once, and two leaves
 * producing the same file is normal rather than a repeat: a swarm-wide
 * filter made the second leaf's copy look like a duplicate of the
 * first's and threw it away, so the task that produced it had nothing
 * on it. The dedupe is therefore scoped to the task when the owner
 * names one, and to the swarm's own runs (the planner's, which name no
 * task) when it does not.
 */
function ownerFilter(owner: ArtifactOwner) {
  if ("featureId" in owner) return eq(runArtifacts.featureId, owner.featureId);
  return and(
    eq(runArtifacts.swarmId, owner.swarmId),
    owner.swarmTaskId
      ? eq(runArtifacts.swarmTaskId, owner.swarmTaskId)
      : isNull(runArtifacts.swarmTaskId),
  );
}
