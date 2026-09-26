import { MAX_SWARM_WORKERS } from "@bento/core";
import { z } from "zod";
import { agentEntry } from "./agent-file.js";
import { isSafeRelativePath } from "./orchestrator/swarm/deliverable.js";
import { firstZodProblem, parseYamlDocument, writeYamlDocument } from "./yaml-file.js";

/**
 * Swarm templates as a file.
 *
 * A template is a team's way of running a swarm: who plans, who works,
 * who judges, where the agents work, and the ceilings a swarm starts
 * with. It is the same kind of knowledge a pipeline is, tuned over
 * weeks and then wanted on a second project or in a second
 * organization, and re-entering it through a form is how it gets lost.
 *
 * Everything is referenced by name rather than by id, the way the
 * pipeline file references agents: an id means nothing in the install
 * a file lands in, and a name is what a person already calls the
 * thing. Templates themselves are matched by name on import, so
 * importing the same file twice edits rather than duplicating.
 *
 * The same entry shape appears inside the pipeline file, under a
 * `swarms:` key, because most teams keep one file beside their code
 * and a second one for the swarm half would be a second thing to
 * remember. Defined here and imported there, so the two cannot drift.
 */

/**
 * What a swarm's agents work in. Stated rather than defaulted, for the
 * reason the column is not defaulted: a template that does not say is
 * a template that makes no claim, and "sandbox" is the value that
 * means no claim.
 */
const workerIsolation = z.enum(["sandbox", "worktree"]);

export const swarmTemplateEntry = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  /** The agents, by name. Undefined leaves the install's own choice. */
  planner: z.string().max(200).nullish(),
  worker: z.string().max(200).nullish(),
  /**
   * The agent that reads a finished swarm before it is called done.
   * Absent is the ordinary case: a swarm is done when its tree is.
   */
  judge: z.string().max(200).nullish(),
  /** Operating instructions on top of each agent's own skill. */
  plannerInstructions: z.string().max(20_000).nullish(),
  workerInstructions: z.string().max(20_000).nullish(),
  isolation: workerIsolation.nullish(),
  /** What this template's swarms produce. */
  deliverable: z.enum(["code", "document"]).default("code"),
  /** Where a document swarm's assembled file goes, relative and markdown. */
  documentPath: z
    .string()
    .trim()
    .max(400)
    .refine((value) => isSafeRelativePath(value), "a document path is a relative .md path inside the repository")
    .nullish(),
  /** A command that has to pass once, at the end, before the swarm is done. */
  completionCommand: z.string().max(4000).nullish(),
  maxWorkers: z.number().int().min(1).max(MAX_SWARM_WORKERS).default(4),
  maxPlanDepth: z.number().int().min(1).max(3).default(1),
  budgetUsd: z.number().min(0).max(100_000).nullish(),
  timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullish(),
  assumedCostUsd: z.number().min(0).max(10_000).nullish(),
  longRunWarnMin: z.number().int().min(1).max(60 * 24).default(20),
  longRunEscalateMin: z.number().int().min(1).max(60 * 24).default(45),
});

export type SwarmTemplateEntry = z.infer<typeof swarmTemplateEntry>;

export const swarmFile = z.object({
  /**
   * Refused rather than guessed at, the way the pipeline file refuses:
   * a file from a later Bento may describe fields this one would
   * silently drop, and a template that imports with pieces missing is
   * worse than one that refuses.
   */
  version: z.literal(1).default(1),
  swarms: z.array(swarmTemplateEntry).min(1).max(50),
  /**
   * The agents the templates name, so a file carries what it refers
   * to. Optional: a file written against an install that already has
   * the agents names them and defines none.
   */
  agents: z.array(agentEntry).max(50).default([]),
});

export type SwarmFile = z.infer<typeof swarmFile>;

/**
 * Every problem a set of template entries can have that zod cannot
 * see, in words, or null.
 *
 * Shared with the pipeline file, which carries the same entries under
 * its own `swarms:` key: two names colliding and an agent named but
 * not defined are the same mistakes there, and a second copy of the
 * checks is how one file would start accepting what the other refuses.
 *
 * `defined` is the agent names the file supplies. A file that defines
 * none names agents the install is expected to have already, which is
 * the ordinary case for a template exported from an install that has
 * them: unresolvable names are the import's to report against the real
 * roster, not this parser's to guess at.
 */
export function swarmEntryProblem(entries: SwarmTemplateEntry[], defined: string[]): string | null {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) return `two swarm templates share the name "${entry.name}"`;
    names.add(entry.name);
  }
  if (defined.length === 0) return null;
  const known = new Set(defined);
  for (const entry of entries) {
    for (const [role, named] of [
      ["planner", entry.planner],
      ["worker", entry.worker],
      ["judge", entry.judge],
    ] as const) {
      if (named && !known.has(named)) {
        return `swarm template "${entry.name}" names the ${role} "${named}", which the file does not define`;
      }
    }
  }
  return null;
}

/** Parses and validates, with the first problem reported in words. */
export function parseSwarmFile(text: string): { data: SwarmFile } | { error: string } {
  const raw = parseYamlDocument(text);
  if ("error" in raw) return raw;
  const parsed = swarmFile.safeParse(raw.data);
  if (!parsed.success) return { error: firstZodProblem(parsed.error.issues) };
  const problem = swarmEntryProblem(
    parsed.data.swarms,
    parsed.data.agents.map((agent) => agent.name),
  );
  return problem ? { error: problem } : { data: parsed.data };
}

/** Serialises, with the long instructions as readable block scalars. */
export function writeSwarmFile(data: SwarmFile): string {
  return writeYamlDocument(data);
}

/**
 * One template row as a file entry.
 *
 * Agents come in already resolved to names, because the row holds ids
 * and this module deliberately knows nothing about the database: a
 * file format that reads tables is a file format that has to change
 * when they do.
 *
 * Null is left out rather than written, so a file says what the
 * template actually sets and a reader is not left deciding whether a
 * null means "no budget" or "nobody has chosen". Absent means the
 * install's own default; the columns' defaults are written, because
 * those are choices the template really made.
 */
export function toSwarmEntry(input: {
  name: string;
  description: string;
  planner: string | null;
  worker: string | null;
  judge: string | null;
  plannerInstructions: string | null;
  workerInstructions: string | null;
  isolation: "sandbox" | "worktree";
  deliverable: "code" | "document";
  documentPath: string | null;
  completionCommand: string | null;
  maxWorkers: number;
  maxPlanDepth: number;
  budgetUsd: string | null;
  timeLimitMin: number | null;
  assumedCostUsd: string | null;
  longRunWarnMin: number;
  longRunEscalateMin: number;
}): SwarmTemplateEntry {
  return {
    name: input.name,
    description: input.description,
    ...(input.planner ? { planner: input.planner } : {}),
    ...(input.worker ? { worker: input.worker } : {}),
    ...(input.judge ? { judge: input.judge } : {}),
    ...(input.plannerInstructions ? { plannerInstructions: input.plannerInstructions } : {}),
    ...(input.workerInstructions ? { workerInstructions: input.workerInstructions } : {}),
    isolation: input.isolation,
    deliverable: input.deliverable,
    ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    ...(input.completionCommand ? { completionCommand: input.completionCommand } : {}),
    maxWorkers: input.maxWorkers,
    maxPlanDepth: input.maxPlanDepth,
    ...(input.budgetUsd === null ? {} : { budgetUsd: Number(input.budgetUsd) }),
    ...(input.timeLimitMin === null ? {} : { timeLimitMin: input.timeLimitMin }),
    ...(input.assumedCostUsd === null ? {} : { assumedCostUsd: Number(input.assumedCostUsd) }),
    longRunWarnMin: input.longRunWarnMin,
    longRunEscalateMin: input.longRunEscalateMin,
  };
}
