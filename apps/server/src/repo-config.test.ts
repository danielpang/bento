import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS_FILE_PATH,
  PIPELINE_FILE_PATH,
  hashRepoConfig,
  pushChangesRepoConfig,
  validateRepoConfig,
} from "./repo-config.js";

const pipelineYaml = `version: 1
pipeline:
  name: Default
  stages:
    - name: Build
      slug: build
      agent: Builder
agents:
  - name: Builder
    tool: fake
    model: fake-1
`;

const agentsYaml = `version: 1
agents:
  - name: Reviewer
    tool: fake
    model: fake-1
    skill: Review it.
`;

test("both files validate together, and either may be absent", () => {
  const both = validateRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml });
  assert.ok(!("error" in both), "error" in both ? both.error : "");
  assert.equal(both.pipeline?.pipeline.stages.length, 1);
  assert.equal(both.agents?.agents.length, 1);

  const onlyAgents = validateRepoConfig({ pipeline: null, agents: agentsYaml });
  assert.ok(!("error" in onlyAgents));
  assert.equal(onlyAgents.pipeline, null);
  assert.equal(onlyAgents.agents?.agents.length, 1);
});

/**
 * One bad file refuses the pair. Applying the good half would leave the
 * board in a shape nobody wrote down, and the message has to say which
 * file to fix.
 */
test("an invalid file is refused with its path named, whichever one it is", () => {
  const badPipeline = validateRepoConfig({ pipeline: "version: 1\npipeline:\n  stages: []\n", agents: agentsYaml });
  assert.ok("error" in badPipeline);
  assert.ok(badPipeline.error.startsWith(`${PIPELINE_FILE_PATH}:`), badPipeline.error);

  const badAgents = validateRepoConfig({ pipeline: pipelineYaml, agents: "agents: [{ name: X }]\n" });
  assert.ok("error" in badAgents);
  assert.ok(badAgents.error.startsWith(`${AGENTS_FILE_PATH}:`), badAgents.error);
});

/**
 * The two files are one configuration. A stage may point at an agent
 * the agents file defines, and only an agent neither file defines is a
 * problem.
 */
test("a stage may name an agent defined in the agents file", () => {
  const pipelineOnlyStage = `version: 1
pipeline:
  stages:
    - name: Review
      slug: review
      agent: Reviewer
`;
  const ok = validateRepoConfig({ pipeline: pipelineOnlyStage, agents: agentsYaml });
  assert.ok(!("error" in ok), "error" in ok ? ok.error : "");

  const alone = validateRepoConfig({ pipeline: pipelineOnlyStage, agents: null });
  assert.ok("error" in alone);
  assert.match(alone.error, /Reviewer/);
  assert.match(alone.error, /neither file defines/);
});

test("the hash tells the pair apart from either file alone", () => {
  const both = hashRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml });
  assert.equal(both, hashRepoConfig({ pipeline: pipelineYaml, agents: agentsYaml }));
  assert.notEqual(both, hashRepoConfig({ pipeline: pipelineYaml, agents: null }));
  assert.notEqual(both, hashRepoConfig({ pipeline: null, agents: agentsYaml }));
  // A file moving from one slot to the other is a different pair.
  assert.notEqual(hashRepoConfig({ pipeline: "a", agents: null }), hashRepoConfig({ pipeline: null, agents: "a" }));
});

/**
 * Only the default branch counts. Feature branches are what agents push
 * to, and a pipeline's requirements are commands the server will run.
 */
test("a push re-reads the files only from the default branch, and only when it touched them", () => {
  const touched = new Set([PIPELINE_FILE_PATH, "src/index.ts"]);
  assert.equal(pushChangesRepoConfig({ branch: "main", paths: touched }, "main"), true);
  assert.equal(pushChangesRepoConfig({ branch: "main", paths: new Set([AGENTS_FILE_PATH]) }, "main"), true);
  assert.equal(pushChangesRepoConfig({ branch: "feature/x", paths: touched }, "main"), false);
  assert.equal(pushChangesRepoConfig({ branch: "main", paths: new Set(["README.md"]) }, "main"), false);
  assert.equal(pushChangesRepoConfig({ branch: "main", paths: new Set([".bento/other.yaml"]) }, "main"), false);
});
