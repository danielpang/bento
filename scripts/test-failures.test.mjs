import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const reporter = fileURLToPath(new URL("./test-failures-reporter.mjs", import.meta.url));
const summary = fileURLToPath(new URL("./test-failures-summary.mjs", import.meta.url));
let temporary, failuresDir, stepSummary;

// What the outer run would otherwise hand the children: its reporters
// and recap directory, which these runs must not touch, and the context
// that makes a nested `node --test` report to its parent instead of
// running as a test run of its own.
function env(extra = {}) {
  const { NODE_OPTIONS, NODE_TEST_CONTEXT, BENTO_TEST_FAILURES_DIR, GITHUB_ACTIONS, GITHUB_STEP_SUMMARY, ...rest } = process.env;
  return { ...rest, ...extra };
}

before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "bento-test-failures-"));
  failuresDir = path.join(temporary, "failures");
  stepSummary = path.join(temporary, "summary.md");
  await writeFile(
    path.join(temporary, "sample.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { describe, test } from "node:test";',
      'describe("a card", () => {',
      '  test("passes", () => {});',
      '  test("moves to review", () => {',
      '    assert.equal("backlog", "review");',
      "  });",
      "});",
      'test("never finishes", { timeout: 20 }, () => new Promise((r) => setTimeout(r, 500)));',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(temporary, "broken.test.mjs"), 'throw new Error("cannot import this");\n');
  await writeFile(stepSummary, "");
  await run(
    process.execPath,
    ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, "--test-reporter-destination=stderr", "sample.test.mjs", "broken.test.mjs"],
    { cwd: temporary, env: env({ BENTO_TEST_FAILURES_DIR: failuresDir }) },
  ).then(
    () => assert.fail("the sample run should fail"),
    () => {},
  );
});

after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function recorded() {
  const files = await readdir(failuresDir);
  const all = [];
  for (const file of files) all.push(...JSON.parse(await readFile(path.join(failuresDir, file), "utf8")));
  return all;
}

test("each failing test is recorded with its describe blocks, line and error, and its parent is not", async () => {
  const failures = await recorded();
  const names = failures.map((f) => f.name).sort();
  assert.deepEqual(names, ["a card > moves to review", "broken.test.mjs", "never finishes"]);
  const assertion = failures.find((f) => f.name === "a card > moves to review");
  assert.equal(assertion.line, 6);
  assert.match(assertion.error, /AssertionError/);
  assert.match(assertion.error, /'backlog'/);
  assert.doesNotMatch(assertion.error, /node:internal/);
  const timeout = failures.find((f) => f.name === "never finishes");
  assert.equal(timeout.line, 9);
  assert.match(timeout.error, /timed out/);
});

test("a file that dies at import carries what it printed", async () => {
  const broken = (await recorded()).find((f) => f.name === "broken.test.mjs");
  assert.match(broken.output, /cannot import this/);
});

test("a passing run records nothing", async () => {
  const dir = path.join(temporary, "passing");
  await writeFile(path.join(temporary, "passing.test.mjs"), 'import { test } from "node:test";\ntest("fine", () => {});\n');
  await run(process.execPath, ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stderr", "passing.test.mjs"], {
    cwd: temporary,
    env: env({ BENTO_TEST_FAILURES_DIR: dir }),
  });
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("the recap lists every failure last, annotates it, and fills the job summary", async () => {
  const { stdout } = await run(process.execPath, [summary, failuresDir], {
    env: env({ GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: stepSummary }),
  });
  assert.match(stdout, /3 failing tests/);
  assert.match(stdout, /✖ \S*sample\.test\.mjs:6 {2}a card > moves to review/);
  assert.match(stdout, /::error file=\S*sample\.test\.mjs,line=6,col=\d+,title=Failed%3A a card > moves to review::AssertionError/);
  const markdown = await readFile(stepSummary, "utf8");
  assert.match(markdown, /## 3 failing tests/);
  assert.match(markdown, /### ✖ a card \\> moves to review/);
});

test("the recap says so when no test failed", async () => {
  const { stdout } = await run(process.execPath, [summary, path.join(temporary, "nothing")], { env: env() });
  assert.match(stdout, /No failing test was recorded/);
});
