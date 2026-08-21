import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile, writeAgentFile } from "./agent-file.js";

const sample = {
  version: 1 as const,
  agents: [
    {
      name: "Software Engineer",
      tool: "claude-code" as const,
      model: "claude-sonnet-5",
      skill: "Build what the previous stages describe.\n\nMatch the code around you.",
      extraArgs: [],
    },
  ],
};

test("an agents file survives the round trip", () => {
  const parsed = parseAgentFile(writeAgentFile(sample));
  assert.ok(!("error" in parsed), "error" in parsed ? parsed.error : "");
  assert.deepEqual((parsed as { data: typeof sample }).data, sample);
});

test("skills are written as readable blocks", () => {
  const text = writeAgentFile(sample);
  assert.match(text, /skill: \|/, "the skill should be a literal block");
  assert.match(text, /\n {6}Match the code around you\./);
});

test("two agents with the same name are refused", () => {
  const doubled = { ...sample, agents: [sample.agents[0]!, sample.agents[0]!] };
  const parsed = parseAgentFile(writeAgentFile(doubled));
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /share the name/);
});

test("a file from a later Bento is refused rather than half applied", () => {
  const parsed = parseAgentFile("version: 2\nagents:\n  - name: X\n    tool: fake\n    model: fake-1\n");
  assert.ok("error" in parsed);
});

test("plain text is reported as not being YAML rather than crashing", () => {
  const parsed = parseAgentFile("this: is: not: valid: yaml:");
  assert.ok("error" in parsed);
});

test("an empty file says so", () => {
  const parsed = parseAgentFile("");
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /empty/);
});

test("the optional parts default rather than being required", () => {
  const parsed = parseAgentFile("agents:\n  - name: Reviewer\n    tool: fake\n    model: fake-1\n");
  assert.ok(!("error" in parsed));
  const { data } = parsed as { data: typeof sample };
  assert.deepEqual(data.agents[0]!.extraArgs, []);
  assert.equal(data.agents[0]!.skill, null);
});
