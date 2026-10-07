import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentsForStages,
  defaultPipelineSeed,
  DEFAULT_AGENTS,
  DEFAULT_STAGES,
  pipelineSeed,
  stageSlugFromName,
  uniqueStageSlug,
} from "./pipeline.js";

test("the default seed is one agent per default stage", () => {
  const seed = defaultPipelineSeed();
  assert.equal(seed.stages.length, DEFAULT_STAGES.length);
  assert.equal(seed.agents.length, DEFAULT_AGENTS.length);
  assert.deepEqual(
    seed.stages.map((stage) => stage.slug).sort(),
    seed.agents.map((agent) => agent.stageSlug).sort(),
  );
  assert.equal(pipelineSeed.safeParse(seed).success, true);
  for (const agent of seed.agents) {
    assert.equal(agent.cli, "claude-code");
  }
});

test("a stage name becomes a slug the pipeline index can store", () => {
  assert.equal(stageSlugFromName("Code review"), "code-review");
  assert.equal(stageSlugFromName("  UI/UX  "), "ui-ux");
  assert.equal(stageSlugFromName("***"), "stage");
  assert.equal(uniqueStageSlug("Design", ["design"]), "design-2");
  assert.equal(uniqueStageSlug("Design", ["design", "design-2"]), "design-3");
});

test("agentsForStages keeps a seeded agent and invents one for a new stage", () => {
  const seed = defaultPipelineSeed();
  const custom = agentsForStages(
    [
      seed.stages[0]!,
      { name: "Security review", slug: "security-review", description: "", gateType: "manual" },
    ],
    seed.agents,
  );
  assert.equal(custom[0]?.name, "Product Manager");
  assert.equal(custom[0]?.skill, seed.agents[0]!.skill);
  assert.equal(custom[1]?.name, "Security review");
  assert.equal(custom[1]?.stageSlug, "security-review");
  assert.equal(pipelineSeed.safeParse({ stages: [seed.stages[0]!, { name: "Security review", slug: "security-review", description: "", gateType: "manual" }], agents: custom }).success, true);
});

test("pipeline seed refuses a stage with no agent", () => {
  const seed = defaultPipelineSeed();
  const parsed = pipelineSeed.safeParse({ ...seed, agents: seed.agents.slice(1) });
  assert.equal(parsed.success, false);
});
