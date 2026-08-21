import { z } from "zod";
import { agentCli } from "@bento/core";
import { firstZodProblem, parseYamlDocument, writeYamlDocument } from "./yaml-file.js";

/**
 * The named agents as a file.
 *
 * An agent is a tool, a model, and a skill. Stages point at one by
 * name. The pipeline file already carries the agents a board uses;
 * this is the same list without the stages, so a team can copy the
 * pairings they have tuned into another install without touching the
 * board.
 *
 * Matched by name on import, the same way the pipeline file does it:
 * an id means nothing in the install the file lands in.
 */

export const agentEntry = z.object({
  name: z.string().min(1).max(200),
  tool: agentCli,
  model: z.string().min(1).max(200),
  skill: z.string().max(20000).nullish().default(null),
  extraArgs: z.array(z.string()).default([]),
});

export type AgentEntry = z.infer<typeof agentEntry>;

export const agentFile = z.object({
  /**
   * Refused rather than guessed at. A file from a later Bento may
   * describe fields this one would silently drop.
   */
  version: z.literal(1).default(1),
  /**
   * Higher than the pipeline file's 50: that cap is "agents a board
   * uses", and a roster can be larger than the stages that point at it.
   * Export writes the whole list, so a cap below how many profiles a
   * person can create would make export fail for a file that import
   * could never have written.
   */
  agents: z.array(agentEntry).max(200).default([]),
});

export type AgentFile = z.infer<typeof agentFile>;

/** Parses and validates, with the first problem reported in words. */
export function parseAgentFile(text: string): { data: AgentFile } | { error: string } {
  const raw = parseYamlDocument(text);
  if ("error" in raw) return raw;
  const parsed = agentFile.safeParse(raw.data);
  if (!parsed.success) return { error: firstZodProblem(parsed.error.issues) };
  const names = new Set<string>();
  for (const agent of parsed.data.agents) {
    if (names.has(agent.name)) return { error: `two agents share the name "${agent.name}"` };
    names.add(agent.name);
  }
  return { data: parsed.data };
}

/** Serialises, with the long skills as readable block scalars. */
export function writeAgentFile(data: AgentFile): string {
  return writeYamlDocument(data);
}
