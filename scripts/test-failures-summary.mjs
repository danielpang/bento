// Prints the failures test-failures-reporter.mjs recorded, as the last
// lines of a failed test step:
//
//   node scripts/test-failures-summary.mjs <dir>
//
// Each failure is printed with its file, line, full test name and error,
// raised as an error annotation (which GitHub shows on the run's page
// and beside the line in the pull request), and written to the job
// summary. It always exits 0: the step's own exit code is the verdict.

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_LISTED = 50;

const dir = process.argv[2] ?? process.env.BENTO_TEST_FAILURES_DIR;
const failures = [];
if (dir && existsSync(dir)) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    failures.push(...JSON.parse(readFileSync(path.join(dir, name), "utf8")));
  }
}
failures.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`, undefined, { numeric: true }));

const rule = "=".repeat(72);
const out = [];
out.push("", rule);
if (failures.length === 0) {
  out.push("No failing test was recorded. The step failed before or outside the test runner (a build, an import that never ran, a crash), so the cause is in the log above.");
  out.push(rule);
  console.log(out.join("\n"));
  process.exit(0);
}

const packages = [...new Set(failures.map((f) => f.package))];
out.push(`${count(failures.length, "failing test")} in ${packages.join(", ")}`);
out.push(rule);
const listed = failures.slice(0, MAX_LISTED);
for (const [index, failure] of listed.entries()) {
  out.push("", `${index + 1}) ${where(failure)}`, `   ${failure.name}`, "");
  out.push(indent(failure.error || "(no error message)", "   "));
  if (failure.output) out.push("", "   Last output from the file:", indent(failure.output, "   | "));
}
if (failures.length > listed.length) out.push("", `... and ${failures.length - listed.length} more, in the log above.`);
out.push("", rule);
out.push(`${count(failures.length, "failing test")}:`);
for (const failure of listed) out.push(`  ✖ ${where(failure)}  ${failure.name}`);
out.push(rule);
console.log(out.join("\n"));

if (process.env.GITHUB_ACTIONS) {
  for (const failure of listed) {
    const props = [];
    if (failure.file) props.push(`file=${property(failure.file)}`);
    if (failure.line) props.push(`line=${failure.line}`);
    if (failure.column) props.push(`col=${failure.column}`);
    props.push(`title=${property(`Failed: ${failure.name}`)}`);
    const body = failure.error.split("\n").slice(0, 12);
    if (failure.output) body.push(...failure.output.split("\n").slice(-12));
    console.log(`::error ${props.join(",")}::${data(body.join("\n"))}`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`## ${count(failures.length, "failing test")}`, ""];
  for (const failure of listed) {
    md.push(`### ✖ ${escapeMarkdown(failure.name)}`, "", `\`${where(failure)}\``, "", fence(failure.error || "(no error message)"));
    if (failure.output) md.push("Last output from the file:", "", fence(failure.output));
  }
  if (failures.length > listed.length) md.push(`And ${failures.length - listed.length} more, in the log.`, "");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join("\n")}\n`);
}

function where(failure) {
  if (!failure.file) return failure.package;
  return failure.line ? `${failure.file}:${failure.line}` : failure.file;
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function fence(text) {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}\n`;
}

function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]<>#|]/g, "\\$&");
}

// Workflow command escaping, as @actions/core does it.
function data(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function property(text) {
  return data(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
