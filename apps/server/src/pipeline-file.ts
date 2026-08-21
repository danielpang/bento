import { z } from "zod";
import { gateCriteria, gateType } from "@bento/core";
import { agentEntry } from "./agent-file.js";
import { firstZodProblem, parseYamlDocument, writeYamlDocument } from "./yaml-file.js";

/**
 * A project's pipeline as a file.
 *
 * Pipelines are the part of Bento people tune for weeks and then want
 * on a second project, or in a second organization, or in a repository
 * beside the code they describe. Clicking six stages and six agents
 * into place again is how that knowledge gets lost, so the whole thing
 * reads and writes as one YAML document.
 *
 * Agents are referenced by name rather than by id: an id means nothing
 * in the install the file lands in, while a name is what a person
 * already calls the thing.
 */

const stageEntry = z.object({
  name: z.string().min(1).max(200),
  /** Identifies the stage across an import, and names its artifact file. */
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "a slug is lower case letters, numbers and dashes"),
  description: z.string().max(4000).default(""),
  gate: gateType.default("manual"),
  /** What must pass before an automatic stage advances. */
  requirements: gateCriteria.default([]),
  createPr: z.boolean().default(false),
  /** The agent that runs this stage, by name. */
  agent: z.string().max(200).nullish(),
});

const repositoryEntry = z.object({
  name: z.string().min(1).max(64),
  setup: z.string().max(4000).nullish(),
  test: z.string().max(4000).nullish(),
});

export const pipelineFile = z.object({
  /**
   * Refused rather than guessed at. A file from a later Bento may
   * describe stages this one would silently drop, and a pipeline that
   * imports with pieces missing is worse than one that refuses.
   */
  version: z.literal(1).default(1),
  pipeline: z.object({
    name: z.string().min(1).max(200).default("Default"),
    stages: z.array(stageEntry).min(1).max(50),
  }),
  agents: z.array(agentEntry).max(50).default([]),
  /**
   * Optional, and matched by name: a file written for one project can
   * be imported into another whose checkouts are called something
   * else, and the commands simply do not apply.
   */
  repositories: z.array(repositoryEntry).max(20).default([]),
});

export type PipelineFile = z.infer<typeof pipelineFile>;

/** Parses and validates, with the first problem reported in words. */
export function parsePipelineFile(text: string): { data: PipelineFile } | { error: string } {
  const raw = parseYamlDocument(text);
  if ("error" in raw) return raw;
  const parsed = pipelineFile.safeParse(raw.data);
  if (!parsed.success) return { error: firstZodProblem(parsed.error.issues) };
  // Slugs identify stages during an import, so two of the same would
  // make the result depend on order.
  const slugs = new Set<string>();
  for (const stage of parsed.data.pipeline.stages) {
    if (slugs.has(stage.slug)) return { error: `two stages share the slug "${stage.slug}"` };
    slugs.add(stage.slug);
  }
  // Every named agent has to be defined, or the stage silently arrives
  // with nothing assigned and the pipeline cannot run.
  const names = new Set(parsed.data.agents.map((agent) => agent.name));
  for (const stage of parsed.data.pipeline.stages) {
    if (stage.agent && !names.has(stage.agent)) {
      return { error: `stage "${stage.slug}" names the agent "${stage.agent}", which the file does not define` };
    }
  }
  return { data: parsed.data };
}

/** Serialises, with the long skills as readable block scalars. */
export function writePipelineFile(data: PipelineFile): string {
  return writeYamlDocument(data);
}
