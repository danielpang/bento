import { z } from "zod";
import { gateType } from "./enums.js";
import { MODEL_GUIDANCE } from "./credentials.js";
import type { GateCriteria } from "./gates.js";

export interface StageDefinition {
  name: string;
  slug: string;
  description: string;
  gateType: "manual" | "auto";
  gateCriteria: GateCriteria;
}

/**
 * The default six stage pipeline seeded with every new project.
 * Fully editable per project afterwards.
 */
export const DEFAULT_STAGES: StageDefinition[] = [
  {
    name: "Product investigation",
    slug: "product-investigation",
    description: "Investigate the problem space and generate feature ideas.",
    gateType: "manual",
    gateCriteria: [],
  },
  {
    name: "UI/UX design",
    slug: "design",
    description: "Design the user interface and experience.",
    gateType: "manual",
    gateCriteria: [],
  },
  {
    name: "Engineering requirements",
    slug: "engineering-requirements",
    description: "Define engineering requirements and technical system design.",
    gateType: "manual",
    gateCriteria: [],
  },
  {
    name: "Implementation",
    slug: "implementation",
    description: "Implement the feature: code and infrastructure.",
    gateType: "manual",
    gateCriteria: [],
  },
  {
    name: "Code review",
    slug: "code-review",
    description: "Review the changes before they merge.",
    gateType: "manual",
    gateCriteria: [],
  },
  {
    name: "Quality engineering",
    slug: "quality-engineering",
    description: "Verify quality: tests, checks, and acceptance criteria.",
    gateType: "manual",
    gateCriteria: [],
  },
];

export interface AgentDefinition {
  name: string;
  /** The stage this one runs, by slug. */
  stageSlug: string;
  /** Operating instructions, sent with every prompt this agent runs. */
  skill: string;
}

/**
 * An agent per stage, seeded alongside the default pipeline.
 *
 * A board with six stages and no agents cannot run anything, and the
 * first thing every new install used to do was invent six job titles
 * before it could see the thing work at all. These are a starting
 * point: rename them, repoint them at another tool or model, or delete
 * the ones a team does not want.
 *
 * The tool and model are deliberately not here. They come from the
 * catalog's own default, which is the cheaper model rather than the
 * best one, because nothing should start spending on a model nobody
 * chose.
 *
 * The skills say what to produce, not how to behave. A stage's value is
 * its written output: the next stage reads it, and a person reviewing
 * the card reads it too.
 */
export const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    name: "Product Manager",
    stageSlug: "product-investigation",
    skill: [
      "Investigate the problem before proposing anything.",
      "",
      "Write up: who has this problem, what they do today, what the change should achieve, and how anybody would know it worked. Name what you are deliberately leaving out.",
      "Ask for the decision you need rather than guessing at it, and say plainly when the evidence does not support building this at all.",
    ].join("\n"),
  },
  {
    name: "Product Designer",
    stageSlug: "design",
    skill: [
      "Design the experience, working from the investigation that came before.",
      "",
      "Describe each screen or state a person moves through, what they see, and what they can do next. Cover the empty, loading, error, and permission-denied states: those are where most designs turn out to be incomplete.",
      "Write the actual words on the buttons and in the messages. Copy is part of the design, not a detail for later.",
    ].join("\n"),
  },
  {
    name: "Staff Engineer",
    stageSlug: "engineering-requirements",
    skill: [
      "Turn the design into a plan somebody else could build from.",
      "",
      "Read the code before proposing anything, and describe the change in terms of what is already there: which modules change, what data has to be stored, what the API accepts and returns.",
      "Call out the risky parts, the migrations, and anything that cannot be undone. Where there is a choice, make it and give the reason.",
    ].join("\n"),
  },
  {
    name: "Software Engineer",
    stageSlug: "implementation",
    skill: [
      "Build what the previous stages describe, and nothing beyond it.",
      "",
      "Match the code around you: its naming, its structure, and how much it comments. Cover the new behaviour with tests, and run the repository's test command before you finish.",
      "If the plan turns out to be wrong once you are in the code, say so in your summary rather than quietly building something else.",
    ].join("\n"),
  },
  {
    name: "Code Reviewer",
    stageSlug: "code-review",
    skill: [
      "Review the changes on this branch against what the earlier stages asked for.",
      "",
      "Check four things and report on each: the change does what the requirements said, it is covered by tests, it introduces no bugs you can find, and it reads clearly enough for the next person.",
      "Be specific: name the file and the line, and say what would go wrong. Say so plainly when the work is sound; a review that invents problems is worse than none.",
    ].join("\n"),
  },
  {
    name: "QA Engineer",
    stageSlug: "quality-engineering",
    skill: [
      "Verify the work rather than re-reading it.",
      "",
      "Run the repository's test command and report exactly what happened. Then look for what the tests do not cover: the edge cases, the failure paths, and anything that would break for a user who does something slightly unusual.",
      "Add the tests that are missing. Report failures as failures; do not describe broken work as done.",
    ].join("\n"),
  },
];

/**
 * Where Bento's own stage write-ups live inside a repository.
 *
 * Named once, because two very different things need it: reading the
 * write-ups back out of the branch, and keeping them out of a pull
 * request unless somebody asked for them.
 */
export const STAGE_ARTIFACT_DIR = "docs/bento";

/** Prior stage artifacts are committed here in the feature branch. */
export function stageArtifactPath(stageSlug: string): string {
  return `${STAGE_ARTIFACT_DIR}/${stageSlug}.md`;
}

/**
 * Where agents put output that does not belong in a repository:
 * mockups, screenshots, HTML previews. Lives at the workspace root,
 * next to the checkouts.
 *
 * Named once for the same reason STAGE_ARTIFACT_DIR is, but the
 * parties are further apart: the prompt names it to the agent, capture
 * reads it back after a run, and the sprite driver must know it is not
 * an abandoned checkout when it sweeps the workspace between runs. The
 * driver deleting it would lose nothing (capture has already run), but
 * probing it for a .git that is not there is how a whole card's
 * provisioning once failed.
 */
export const WORKSPACE_ARTIFACT_DIR = "artifacts";

/**
 * A pipeline plus the agents that run it, as stored for an organization
 * after setup and applied to every project created afterwards.
 *
 * Distinct from StageDefinition: a seed is what a person chose, not the
 * catalog of gate criteria a live stage can carry. New stages start
 * with an empty list, the same way a stage added from the board does.
 */
export interface PipelineSeedStage {
  name: string;
  slug: string;
  description: string;
  gateType: "manual" | "auto";
}

export interface PipelineSeedAgent {
  name: string;
  stageSlug: string;
  skill: string;
  cli: SetupAgentCli;
  model: string;
}

export interface PipelineSeed {
  stages: PipelineSeedStage[];
  agents: PipelineSeedAgent[];
}

/** Tools the setup form offers. The fake agent is a test fixture. */
export const setupAgentCli = z.enum(["claude-code", "codex", "cursor", "opencode", "pi"]);
export type SetupAgentCli = z.infer<typeof setupAgentCli>;

export const pipelineSeedStage = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(500),
  gateType,
});

export const pipelineSeedAgent = z.object({
  name: z.string().min(1).max(80),
  stageSlug: z.string().min(1).max(48),
  skill: z.string().max(20000),
  cli: setupAgentCli,
  model: z.string().min(1).max(200),
});

export const pipelineSeed = z
  .object({
    stages: z.array(pipelineSeedStage).min(1).max(20),
    agents: z.array(pipelineSeedAgent).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    const slugs = value.stages.map((stage) => stage.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({ code: "custom", message: "each stage needs its own slug", path: ["stages"] });
    }
    const names = value.agents.map((agent) => agent.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "each agent needs its own name", path: ["agents"] });
    }
    const known = new Set(slugs);
    const assigned = new Set(value.agents.map((agent) => agent.stageSlug));
    for (const stage of value.stages) {
      if (!assigned.has(stage.slug)) {
        ctx.addIssue({
          code: "custom",
          message: `stage "${stage.slug}" has no agent`,
          path: ["agents"],
        });
      }
    }
    for (const [i, agent] of value.agents.entries()) {
      if (!known.has(agent.stageSlug)) {
        ctx.addIssue({
          code: "custom",
          message: `agent "${agent.name}" points at a stage that is not in this pipeline`,
          path: ["agents", i, "stageSlug"],
        });
      }
    }
  });

/** The cheaper default, same one a seeded agent has always used. */
export function defaultSeedCli(): SetupAgentCli {
  return "claude-code";
}

export function defaultSeedModel(cli: SetupAgentCli = defaultSeedCli()): string {
  return MODEL_GUIDANCE.find((tool) => tool.cli === cli)?.defaultModel ?? "claude-sonnet-5";
}

/**
 * Bento's opinionated starting pipeline: six stages, all manual, Claude
 * Code on the cheaper model, one agent per stage.
 */
export function defaultPipelineSeed(): PipelineSeed {
  const cli = defaultSeedCli();
  const model = defaultSeedModel(cli);
  return {
    stages: DEFAULT_STAGES.map(({ name, slug, description, gateType: mode }) => ({
      name,
      slug,
      description,
      gateType: mode,
    })),
    agents: DEFAULT_AGENTS.map((agent) => ({ ...agent, cli, model })),
  };
}

/** stages_pipeline_slug_idx wants uniqueness; the name drives the slug. */
export function stageSlugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40) || "stage"
  );
}

export function uniqueStageSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = stageSlugFromName(name);
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/**
 * An agent for every stage. Known slugs keep their seeded agent; a
 * stage the catalog does not know gets a short skill of its own so
 * the next stage still has something to read.
 */
export function agentsForStages(
  stages: PipelineSeedStage[],
  previous: PipelineSeedAgent[] = [],
): PipelineSeedAgent[] {
  const catalog = new Map(defaultPipelineSeed().agents.map((agent) => [agent.stageSlug, agent]));
  const kept = new Map(previous.map((agent) => [agent.stageSlug, agent]));
  const usedNames = new Set<string>();
  return stages.map((stage) => {
    const agent = kept.get(stage.slug) ?? catalog.get(stage.slug) ?? unnamedAgentFor(stage);
    let name = agent.name;
    if (usedNames.has(name)) name = uniqueAgentName(name, usedNames);
    usedNames.add(name);
    return { ...agent, name, stageSlug: stage.slug };
  });
}

function unnamedAgentFor(stage: PipelineSeedStage): PipelineSeedAgent {
  const cli = defaultSeedCli();
  return {
    name: stage.name,
    stageSlug: stage.slug,
    skill: [
      "Do the work this stage is for.",
      "",
      "Write up what you did so the next stage can start from it. Say what you left out, and ask for the decision you need rather than guessing at it.",
    ].join("\n"),
    cli,
    model: defaultSeedModel(cli),
  };
}

function uniqueAgentName(name: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const next = `${name} ${n}`;
    if (!taken.has(next)) return next;
  }
}
