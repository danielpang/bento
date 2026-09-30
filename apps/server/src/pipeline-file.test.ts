import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePipelineFile, writePipelineFile } from "./pipeline-file.js";

const sample = {
  version: 1 as const,
  pipeline: {
    name: "Default",
    stages: [
      {
        name: "Implementation",
        slug: "implementation",
        description: "Build it.",
        gate: "auto" as const,
        requirements: [{ type: "checks_pass" as const }],
        createPr: true,
        agent: "Software Engineer",
      },
    ],
  },
  agents: [
    {
      name: "Software Engineer",
      tool: "claude-code" as const,
      model: "claude-sonnet-5",
      skill: "Build what the previous stages describe.\n\nMatch the code around you.",
      extraArgs: [],
    },
  ],
  repositories: [{ name: "api", setup: "npm ci", test: "npm test" }],
};

test("a pipeline survives the round trip", () => {
  const parsed = parsePipelineFile(writePipelineFile(sample));
  assert.ok(!("error" in parsed), "error" in parsed ? parsed.error : "");
  assert.deepEqual((parsed as { data: typeof sample }).data, sample);
});

/**
 * A skill is a paragraph. Quoted or folded it comes back as one long
 * line, which defeats the point of having a file at all.
 */
test("skills are written as readable blocks", () => {
  const text = writePipelineFile(sample);
  assert.match(text, /skill: \|/, "the skill should be a literal block");
  assert.match(text, /\n {6}Match the code around you\./);
});

test("a stage naming an agent the file does not define is refused", () => {
  const orphan = { ...sample, agents: [] };
  const parsed = parsePipelineFile(writePipelineFile(orphan));
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /Software Engineer/);
});

test("two stages with the same slug are refused", () => {
  const doubled = {
    ...sample,
    pipeline: { ...sample.pipeline, stages: [sample.pipeline.stages[0]!, sample.pipeline.stages[0]!] },
  };
  const parsed = parsePipelineFile(writePipelineFile(doubled));
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /share the slug/);
});

test("a file from a later Bento is refused rather than half applied", () => {
  const parsed = parsePipelineFile("version: 2\npipeline:\n  stages:\n    - name: X\n      slug: x\n");
  assert.ok("error" in parsed);
});

test("plain text is reported as not being YAML rather than crashing", () => {
  const parsed = parsePipelineFile("this: is: not: valid: yaml:");
  assert.ok("error" in parsed);
});

test("an empty file says so", () => {
  const parsed = parsePipelineFile("");
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /empty/);
});

/** The minimum somebody would hand write: names, slugs, nothing else. */
test("the optional parts default rather than being required", () => {
  const parsed = parsePipelineFile("pipeline:\n  stages:\n    - name: Build\n      slug: build\n");
  assert.ok(!("error" in parsed));
  const { data } = parsed as { data: ReturnType<typeof structuredClone<typeof sample>> };
  assert.equal(data.pipeline.stages[0]!.gate, "manual");
  assert.deepEqual(data.pipeline.stages[0]!.requirements, []);
  assert.equal(data.pipeline.stages[0]!.createPr, false);
  assert.deepEqual(data.agents, []);
});
