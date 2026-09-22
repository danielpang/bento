import assert from "node:assert/strict";
import test from "node:test";
import { parsePipelineFile } from "./pipeline-file.js";
import { parseSwarmFile, toSwarmEntry, writeSwarmFile } from "./swarm-file.js";

/**
 * Swarm templates as a file.
 *
 * A template is the part of a swarm a team tunes and then wants
 * somewhere else, so the format is held to the same two rules the
 * pipeline file is held to: it refuses rather than importing with
 * pieces missing, and everything it refers to it refers to by name.
 */

const FULL = `
version: 1
swarms:
  - name: Feature work
    description: The way we split a feature.
    planner: Architect
    worker: Builder
    judge: Reviewer
    plannerInstructions: |
      Split by the files that change together.

      Two leaves that edit the same lines are one leaf.
    isolation: worktree
    deliverable: code
    completionCommand: pnpm test
    maxWorkers: 6
    maxPlanDepth: 2
    budgetUsd: 40
    timeLimitMin: 240
agents:
  - name: Architect
    tool: claude-code
    model: sonnet
  - name: Builder
    tool: claude-code
    model: haiku
  - name: Reviewer
    tool: claude-code
    model: sonnet
`;

test("a template file carries everything a template actually sets", () => {
  const parsed = parseSwarmFile(FULL);
  assert.ok(!("error" in parsed), "error" in parsed ? parsed.error : "");
  if ("error" in parsed) return;

  const [entry] = parsed.data.swarms;
  assert.equal(entry!.name, "Feature work");
  assert.equal(entry!.planner, "Architect");
  assert.equal(entry!.judge, "Reviewer");
  assert.equal(entry!.isolation, "worktree");
  assert.equal(entry!.completionCommand, "pnpm test");
  assert.equal(entry!.maxPlanDepth, 2);
  assert.equal(entry!.budgetUsd, 40);
  assert.match(entry!.plannerInstructions!, /Two leaves that edit the same lines are one leaf\./);
  assert.equal(parsed.data.agents.length, 3);
});

test("a file that names an agent it does not define is refused rather than half applied", () => {
  /**
   * The pipeline file's rule, for the same reason: a template whose
   * planner resolved to nothing would import quietly and then start
   * nothing, and a person would be left looking at a template that
   * seems complete.
   */
  const parsed = parseSwarmFile(`
version: 1
swarms:
  - name: Feature work
    planner: Missing
agents:
  - name: Architect
    tool: claude-code
    model: sonnet
`);
  assert.ok("error" in parsed);
  if (!("error" in parsed)) return;
  assert.match(parsed.error, /names the planner "Missing", which the file does not define/);
});

test("a file that defines no agents names the install's own, and is not refused for it", () => {
  /**
   * A template exported from an install that already has the agents
   * names them and defines none. Which names resolve is the import's
   * question, against the real roster, not this parser's to guess.
   */
  const parsed = parseSwarmFile(`
version: 1
swarms:
  - name: Feature work
    planner: Architect
`);
  assert.ok(!("error" in parsed));
});

test("two templates of one name are refused, because an import would depend on order", () => {
  const parsed = parseSwarmFile(`
version: 1
swarms:
  - name: Feature work
  - name: Feature work
`);
  assert.ok("error" in parsed);
  if (!("error" in parsed)) return;
  assert.match(parsed.error, /two swarm templates share the name "Feature work"/);
});

test("a document path that climbs out of the repository is refused", () => {
  /**
   * The server writes to this path. A template is written by a person
   * on the team rather than by an agent, so this is not the tenant
   * boundary; it is the same care every other stored path gets.
   */
  const parsed = parseSwarmFile(`
version: 1
swarms:
  - name: Notes
    deliverable: document
    documentPath: ../../etc/passwd.md
`);
  assert.ok("error" in parsed);
  if (!("error" in parsed)) return;
  assert.match(parsed.error, /relative \.md path inside the repository/);
});

test("a file from a later Bento is refused rather than half read", () => {
  const parsed = parseSwarmFile("version: 2\nswarms:\n  - name: Feature work\n");
  assert.ok("error" in parsed);
});

test("what is written reads back as what was written", () => {
  const entry = toSwarmEntry({
    name: "Feature work",
    description: "",
    planner: "Architect",
    worker: "Builder",
    judge: null,
    plannerInstructions: "Split by the files that change together.",
    workerInstructions: null,
    isolation: "sandbox",
    deliverable: "document",
    documentPath: "docs/plan.md",
    completionCommand: null,
    maxWorkers: 4,
    maxPlanDepth: 1,
    budgetUsd: "12.50",
    timeLimitMin: null,
    assumedCostUsd: null,
    longRunWarnMin: 20,
    longRunEscalateMin: 45,
  });
  // What the template does not set is left out rather than written
  // null, so a reader is not left deciding whether a null means "no
  // budget" or "nobody has chosen".
  assert.equal("judge" in entry, false);
  assert.equal("timeLimitMin" in entry, false);
  assert.equal(entry.budgetUsd, 12.5);

  const text = writeSwarmFile({ version: 1, swarms: [entry], agents: [] });
  const back = parseSwarmFile(text);
  assert.ok(!("error" in back), "error" in back ? back.error : "");
  if ("error" in back) return;
  assert.deepEqual(back.data.swarms[0], entry);
});

test("the pipeline file carries the same templates, under its own key", () => {
  /**
   * One file beside the code, not two. The entry shape is the swarm
   * file's, imported rather than restated, so the two cannot come to
   * disagree about what a template is.
   */
  const parsed = parsePipelineFile(`
version: 1
pipeline:
  name: Default
  stages:
    - name: Build
      slug: build
      agent: Builder
agents:
  - name: Builder
    tool: claude-code
    model: haiku
swarms:
  - name: Feature work
    worker: Builder
    maxPlanDepth: 2
`);
  assert.ok(!("error" in parsed), "error" in parsed ? parsed.error : "");
  if ("error" in parsed) return;
  assert.equal(parsed.data.swarms.length, 1);
  assert.equal(parsed.data.swarms[0]!.maxPlanDepth, 2);
});

test("a pipeline file written before swarms existed still imports", () => {
  const parsed = parsePipelineFile(`
version: 1
pipeline:
  name: Default
  stages:
    - name: Build
      slug: build
`);
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.deepEqual(parsed.data.swarms, []);
});

test("the pipeline file refuses a template naming an agent it does not define", () => {
  const parsed = parsePipelineFile(`
version: 1
pipeline:
  name: Default
  stages:
    - name: Build
      slug: build
agents:
  - name: Builder
    tool: claude-code
    model: haiku
swarms:
  - name: Feature work
    planner: Missing
`);
  assert.ok("error" in parsed);
  if (!("error" in parsed)) return;
  assert.match(parsed.error, /names the planner "Missing"/);
});
