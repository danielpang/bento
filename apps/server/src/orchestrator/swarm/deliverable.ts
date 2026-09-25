import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq } from "drizzle-orm";
import { agentRuns, runArtifacts, swarmTasks, swarms, type Db } from "@bento/db";
import { writeFileCommand } from "@bento/agents";
import { collectExec, repositoryPathIn, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";

const exec = promisify(execFile);

/**
 * A swarm whose deliverable is a document rather than a change.
 *
 * The tree is the same tree, the agents are the same agents, and the
 * merge queue lands the same way. Three things differ, and all three
 * are here.
 *
 * **A leaf writes a section.** Its own file, under one directory, named
 * after the node. One file per leaf and never one shared file, for the
 * reason each leaf gets its own branch: several agents editing one file
 * is the conflict the merge queue exists to avoid, and in prose a
 * conflict is not a merge git can do anything sensible with.
 *
 * **The sections are assembled once, at the end.** In tree order, under
 * the plan's own headings, so the document reads as the plan reads.
 * Done on the server rather than in an agent turn, and that is a
 * deliberate departure from what the phase plan asked for: a swarm's
 * one chance at a deliverable would otherwise sit behind a turn that
 * can run out of budget, crash, or simply not call the tool, and a
 * document swarm that produced nothing is worse than one whose
 * introduction was written by a program. What the planner writes is
 * still in the document: its design note is the preamble, which is the
 * part only the planner could have written.
 *
 * **Nothing is built and nothing is tested.** A repository's setup
 * command installs a toolchain no agent here will use, and its test
 * command has nothing to run against: a leaf that wrote a section
 * changed no code. Both are skipped rather than run and ignored,
 * because installing a toolchain is minutes per worker and a test
 * command that fails on an unrelated change would fail every leaf.
 */

/** Where a leaf's section goes, relative to the first repository's root. */
export const SECTION_DIR = "docs/sections";

/** The server-owned node that gates a document swarm's completion. */
export const DOCUMENT_ASSEMBLY_FLAG = "documentAssembly";

/** Whether this is Bento's assembly node rather than agent work. */
export function isDocumentAssembly(task: Pick<typeof swarmTasks.$inferSelect, "flags">): boolean {
  return task.flags?.[DOCUMENT_ASSEMBLY_FLAG] === true;
}

/** Which initial pass or follow up this assembly belongs to. */
export function documentAssemblyPass(task: Pick<typeof swarmTasks.$inferSelect, "flags">): number | null {
  if (!isDocumentAssembly(task)) return null;
  const value = task.flags.reopenCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Whether this swarm's leaves write prose rather than code. */
export function isDocumentSwarm(swarm: Pick<typeof swarms.$inferSelect, "deliverable">): boolean {
  return swarm.deliverable === "document";
}

/**
 * The file the assembled document is written to.
 *
 * The template's own path when it set one, and `docs/<slug>.md`
 * otherwise. Worked out from the slug rather than the title, because
 * the slug is already the thing that is safe in a branch name and a
 * URL, and a title is a sentence somebody typed.
 */
export function documentPathFor(
  swarm: Pick<typeof swarms.$inferSelect, "slug">,
  templatePath?: string | null,
): string {
  const named = templatePath?.trim();
  if (named && isSafeRelativePath(named)) return named;
  return `docs/${swarm.slug}.md`;
}

/** The file one leaf writes its section into. */
export function sectionPathFor(task: Pick<typeof swarmTasks.$inferSelect, "id">): string {
  return `${SECTION_DIR}/${task.id}.md`;
}

/**
 * A path an agent or a template named, checked before anything is
 * written to it.
 *
 * Inside the repository and nowhere else: no absolute path, nothing
 * that climbs out with "..", no backslashes, nothing hidden. A
 * template is written by a person on the team rather than by an agent,
 * so this is not the tenant boundary; it is the same care every other
 * path this server builds out of a stored string gets.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return value.endsWith(".md");
}

/** One section, as the assembled document reads it. */
export interface DocumentSection {
  /** The node's title, which is the heading the section gets. */
  title: string;
  /** How deep in the plan it sits, so the headings nest as the plan does. */
  depth: number;
  /** What the leaf wrote, or null when it wrote nothing. */
  body: string | null;
  /** Said under the heading when a leaf produced nothing. */
  note?: string;
}

/**
 * The document, from the plan and the sections.
 *
 * Headings come from the plan rather than from the prose, which is what
 * makes this assembly rather than concatenation: a plan node becomes a
 * heading at its own depth and its leaves become the headings under it,
 * so the document has the shape a person approved when they read the
 * tree. A leaf's own text is inserted as written, with its heading
 * level normalized so a section that opened with an h1 does not outrank
 * the document's own title.
 *
 * A leaf with nothing to show gets its heading and a sentence saying
 * so. Leaving it out would produce a document that silently disagrees
 * with the plan it was made from, and the gap is exactly what a person
 * reviewing it needs to see.
 */
export function assembleDocument(input: {
  title: string;
  goal: string;
  /** The planner's design note, which is the only prose about the whole. */
  preamble: string | null;
  sections: DocumentSection[];
}): string {
  const lines: string[] = [`# ${input.title}`, ""];
  if (input.goal.trim()) lines.push(input.goal.trim(), "");
  if (input.preamble?.trim()) lines.push(shiftHeadings(input.preamble.trim(), 1), "");

  for (const section of input.sections) {
    // Capped, because a plan can nest deeper than markdown has levels
    // and an h7 is not a heading at all.
    const level = Math.min(6, section.depth + 2);
    lines.push(`${"#".repeat(level)} ${section.title}`, "");
    if (section.body?.trim()) {
      lines.push(shiftHeadings(section.body.trim(), level), "");
    } else {
      lines.push(section.note ?? "Nothing was written for this section.", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Pushes a fragment's own headings below the one it sits under.
 *
 * A leaf writes its section as a document in its own right, so it
 * usually opens with an h1. Dropped in as written, that h1 would
 * outrank the heading the plan gave it and the document's outline
 * would be the reverse of the plan's. So every heading is moved down
 * by as much as it takes to put the shallowest one just under its
 * place in the plan.
 *
 * Fenced code is left alone: a "#" at the start of a line inside a
 * shell block is a comment, and rewriting it would change a command
 * somebody is meant to run.
 */
export function shiftHeadings(markdown: string, under: number): string {
  const lines = markdown.split("\n");
  let shallowest = 7;
  let fenced = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,6})\s/.exec(line);
    if (match) shallowest = Math.min(shallowest, match[1]!.length);
  }
  if (shallowest > 6) return markdown;
  const by = Math.max(0, under + 1 - shallowest);
  if (by === 0) return markdown;

  fenced = false;
  return lines
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const match = /^(#{1,6})(\s)/.exec(line);
      if (!match) return line;
      const level = Math.min(6, match[1]!.length + by);
      return `${"#".repeat(level)}${match[2]}${line.slice(match[0].length)}`;
    })
    .join("\n");
}

/** What one assembly did, for the log and for the tests. */
export interface AssembledDocument {
  path: string;
  content: string;
  /** How many leaves contributed prose, out of how many were expected. */
  written: number;
  sections: number;
  /** Whether a commit was made. False when the file was already right. */
  committed: boolean;
}

/**
 * Reads a swarm's sections out of its checkout, writes the assembled
 * document, commits it on the swarm's branch, and records it as the
 * swarm's artifact.
 *
 * Both halves on purpose, and they answer different questions. The
 * commit is what a reviewer reads in the pull request, in the branch
 * the rest of the work is on. The artifact is what the console shows
 * without anybody having to clone anything, and it goes through the
 * ordinary run_artifacts path, so it is served by the ordinary
 * artifact route under the ordinary rules: markdown, rendered with raw
 * HTML off, never executing as the console.
 *
 * A leaf that wrote no section file falls back to its report, which is
 * the same prose one step earlier: a worker that wrote its section
 * into its report instead of into a file has still done the work, and
 * a document with a hole in it over a filing mistake helps nobody.
 */
export async function assembleSwarmDocument(
  db: Pick<Db, "select" | "insert" | "update">,
  input: {
    swarm: typeof swarms.$inferSelect;
    /** The checkout the merge queue has been landing into. */
    worktreePath: string;
    /** The template's document path, when it named one. */
    templatePath?: string | null;
    /** The planner's design note, which becomes the preamble. */
    preamble?: string | null;
    /** The run to file the artifact under, when the caller has one. */
    runId?: string | null;
  },
): Promise<AssembledDocument | null> {
  if (!isDocumentSwarm(input.swarm)) return null;

  const tasks = await db
    .select()
    .from(swarmTasks)
    .where(eq(swarmTasks.swarmId, input.swarm.id))
    .orderBy(asc(swarmTasks.position), asc(swarmTasks.createdAt));

  const sections = await readSections(input.worktreePath, tasks);
  if (sections.length === 0) return null;

  const content = assembleDocument({
    title: input.swarm.title,
    goal: input.swarm.goal,
    preamble: input.preamble ?? null,
    sections,
  });

  const relative = documentPathFor(input.swarm, input.templatePath);
  const absolute = path.join(input.worktreePath, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const existing = await readFile(absolute, "utf8").catch(() => null);
  if (existing !== content) await writeFile(absolute, content, "utf8");

  const committed = await commitDocument(input.worktreePath, relative, input.swarm.title);

  /*
   * The run to hang the artifact off. Any of the swarm's own runs will
   * do, and the newest is the one closest to the document: the
   * artifact routes read the swarm rather than the run to decide who
   * may see it, so this is filing rather than authority. A swarm with
   * no run at all records nothing, because run_artifacts.run_id is not
   * nullable.
   */
  await recordDocumentArtifact(db, {
    swarmId: input.swarm.id,
    runId: input.runId ?? (await newestRunId(db, input.swarm.id)),
    path: relative,
    content,
  });

  return {
    path: relative,
    content,
    written: sections.filter((section) => section.body !== null).length,
    sections: sections.length,
    committed,
  };
}

/**
 * The same assembly against a repository that lives inside a sandbox.
 *
 * Every driver goes through exec, including Sprite. Content is written
 * by the literal writer used for MCP configuration, and every git
 * argument is server-owned. Nothing here needs a remote credential in
 * the machine.
 */
export async function assembleSwarmDocumentInSandbox(
  db: Pick<Db, "select" | "insert" | "update">,
  input: {
    swarm: typeof swarms.$inferSelect;
    driver: SandboxDriver;
    handle: SandboxHandle;
    repositoryName: string;
    branch: string;
    templatePath?: string | null;
    preamble?: string | null;
    runId?: string | null;
  },
): Promise<AssembledDocument | null> {
  if (!isDocumentSwarm(input.swarm)) return null;
  const tasks = await db
    .select()
    .from(swarmTasks)
    .where(eq(swarmTasks.swarmId, input.swarm.id))
    .orderBy(asc(swarmTasks.position), asc(swarmTasks.createdAt));
  const cwd = repositoryPathIn(input.handle.workdir, input.repositoryName);
  const sections = await sectionsFromTasks(tasks, async (task) => {
    const result = await collectExec(
      input.driver.exec(input.handle, ["cat", "--", sectionPathFor(task)], { cwd, timeoutMs: 60_000 }),
    );
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout;
    return task.report?.trim() ? task.report : null;
  });
  if (sections.length === 0) return null;

  const content = assembleDocument({
    title: input.swarm.title,
    goal: input.swarm.goal,
    preamble: input.preamble ?? null,
    sections,
  });
  const relative = documentPathFor(input.swarm, input.templatePath);
  const current = await checkedSandbox(input.driver, input.handle, ["git", "symbolic-ref", "--short", "HEAD"], cwd);
  if (current.stdout.trim() !== input.branch) {
    throw new Error(`the swarm checkout is on ${current.stdout.trim() || "no branch"}, not ${input.branch}`);
  }
  await checkedSandbox(
    input.driver,
    input.handle,
    writeFileCommand({ path: `${cwd}/${relative}`, content }),
    cwd,
  );
  await checkedSandbox(input.driver, input.handle, ["git", "add", "--", relative], cwd);
  const changed = await collectExec(
    input.driver.exec(input.handle, ["git", "diff", "--cached", "--quiet", "--", relative], {
      cwd,
      timeoutMs: 60_000,
    }),
  );
  if (changed.exitCode !== 0 && changed.exitCode !== 1) {
    throw new Error(changed.stderr.trim() || changed.stdout.trim() || `git diff exited ${changed.exitCode}`);
  }
  const committed = changed.exitCode === 1;
  if (committed) {
    await checkedSandbox(
      input.driver,
      input.handle,
      [
        "git",
        "-c",
        "user.name=Bento",
        "-c",
        "user.email=no-reply@usebento.ai",
        "commit",
        "--only",
        "-m",
        `Assemble ${input.swarm.title}`,
        "--",
        relative,
      ],
      cwd,
    );
  }
  await recordDocumentArtifact(db, {
    swarmId: input.swarm.id,
    runId: input.runId ?? (await newestRunId(db, input.swarm.id)),
    path: relative,
    content,
  });
  return {
    path: relative,
    content,
    written: sections.filter((section) => section.body !== null).length,
    sections: sections.length,
    committed,
  };
}

/**
 * The plan, read as sections, in tree order.
 *
 * Cancelled nodes are left out entirely: a section somebody withdrew
 * is not a gap in the document, it is work that is not part of it. A
 * plan node contributes its heading and nothing else, which is what
 * makes the document's outline the plan's outline.
 */
async function readSections(
  worktreePath: string,
  tasks: (typeof swarmTasks.$inferSelect)[],
): Promise<DocumentSection[]> {
  const dir = path.join(worktreePath, SECTION_DIR);
  const present = new Set(await readdir(dir).catch(() => []));
  return sectionsFromTasks(tasks, (task) => readSection(dir, present, task));
}

/** Builds the outline once, independently of where its files live. */
async function sectionsFromTasks(
  tasks: (typeof swarmTasks.$inferSelect)[],
  readBody: (task: typeof swarmTasks.$inferSelect) => Promise<string | null>,
): Promise<DocumentSection[]> {
  const byParent = new Map<string | null, (typeof swarmTasks.$inferSelect)[]>();
  for (const task of tasks) {
    if (task.status === "cancelled" || isDocumentAssembly(task) || task.flags?.finalCheck === true) continue;
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }

  const sections: DocumentSection[] = [];
  const seen = new Set<string>();
  const walk = async (parentId: string | null, depth: number): Promise<void> => {
    for (const task of byParent.get(parentId) ?? []) {
      // The tree comes from an agent, so a cycle is possible and a
      // node visited twice would be a section printed twice.
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (task.nodeType === "leaf") {
        sections.push({
          title: task.title,
          depth,
          body: await readBody(task),
          note:
            task.status === "done" || task.status === "landed"
              ? "This section was finished, but nothing was written down for it."
              : `This section is ${task.status}, so nothing has been written for it yet.`,
        });
      } else {
        sections.push({ title: task.title, depth, body: null, note: "" });
      }
      await walk(task.id, depth + 1);
    }
  };
  await walk(null, 0);
  return sections;
}

/** One leaf's prose: its section file, or the report it wrote instead. */
async function readSection(
  dir: string,
  present: Set<string>,
  task: typeof swarmTasks.$inferSelect,
): Promise<string | null> {
  const named = `${task.id}.md`;
  if (present.has(named)) {
    const text = await readFile(path.join(dir, named), "utf8").catch(() => null);
    if (text?.trim()) return text;
  }
  return task.report?.trim() ? task.report : null;
}

/** The newest run of this swarm, which the artifact is filed under. */
async function newestRunId(db: Pick<Db, "select">, swarmId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmId, swarmId), eq(agentRuns.type, "swarm")))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(1);
  return row?.id ?? null;
}

/** One artifact row per swarm document, updated after every follow up. */
async function recordDocumentArtifact(
  db: Pick<Db, "select" | "insert" | "update">,
  input: { swarmId: string; runId: string | null; path: string; content: string },
): Promise<void> {
  if (!input.runId) throw new Error("the document cannot be filed because this swarm has no run");
  const [existing] = await db
    .select({ id: runArtifacts.id })
    .from(runArtifacts)
    .where(
      and(
        eq(runArtifacts.swarmId, input.swarmId),
        eq(runArtifacts.stageSlug, "document"),
        eq(runArtifacts.path, input.path),
      ),
    )
    .limit(1);
  const values = {
    runId: input.runId,
    type: "swarm" as const,
    swarmId: input.swarmId,
    stageSlug: "document",
    stageName: "Document",
    path: input.path,
    kind: "markdown" as const,
    mime: "text/markdown",
    size: Buffer.byteLength(input.content, "utf8"),
    content: input.content,
  };
  if (existing) {
    await db.update(runArtifacts).set({ ...values, createdAt: new Date() }).where(eq(runArtifacts.id, existing.id));
  } else {
    await db.insert(runArtifacts).values(values);
  }
}

/** One trusted sandbox command, with provider detail preserved on failure. */
async function checkedSandbox(
  driver: SandboxDriver,
  handle: SandboxHandle,
  argv: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await collectExec(driver.exec(handle, argv, { cwd, timeoutMs: 60_000 }));
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${argv[0]} exited ${result.exitCode}`);
  }
  return result;
}

/**
 * Commits the assembled document, if it changed anything.
 *
 * As Bento rather than as an agent, the way a landing commits: nothing
 * here was written by a person or by a model, it was assembled from
 * what they wrote. A checkout with nothing to commit answers false
 * rather than failing, which is what a second publish of an unchanged
 * swarm looks like.
 */
async function commitDocument(worktreePath: string, relative: string, title: string): Promise<boolean> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Bento",
    GIT_AUTHOR_EMAIL: "bento@localhost",
    GIT_COMMITTER_NAME: "Bento",
    GIT_COMMITTER_EMAIL: "bento@localhost",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
  };
  const git = (args: string[]) => exec("git", ["-C", worktreePath, ...args], { env, maxBuffer: 32 * 1024 * 1024 });
  await git(["add", "--", relative]);
  const { stdout } = await git(["status", "--porcelain", "--", relative]);
  if (!stdout.trim()) return false;
  await git(["commit", "--quiet", "-m", `Assemble ${title}`, "--", relative]);
  return true;
}
