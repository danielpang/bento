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
