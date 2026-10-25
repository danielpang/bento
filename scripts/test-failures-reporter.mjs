// A node:test reporter that prints nothing and records every failing
// test as JSON in BENTO_TEST_FAILURES_DIR, for test-failures-summary.mjs
// to print once the whole run is over.
//
// It exists for CI logs read on a phone. GitHub mobile opens a failed
// step at its last line, and the last lines of `pnpm test` are turbo's
// "Failed: @bento/server#test", hundreds of lines below the assertion,
// interleaved with every other package's output. The summary puts the
// file, line, test name and error where the reader lands.
//
// CI adds it beside the spec reporter through NODE_OPTIONS, so a local
// run and its output are unchanged. Without the directory it does
// nothing at all.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ERROR_LINES = 40;
const MAX_OUTPUT_LINES = 30;

export default async function* failuresReporter(source) {
  const dir = process.env.BENTO_TEST_FAILURES_DIR;
  // The names of the tests currently open in each file, by nesting, so a
  // failure can be named with its describe blocks.
  const open = new Map();
  // The last lines each file printed. A file that dies at import fails
  // as a test named after the file with the error "test failed", and the
  // real reason is only in what it wrote to stderr.
  const output = new Map();
  const failures = [];

  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:start") {
      const names = open.get(data.file) ?? [];
      names.length = data.nesting;
      names.push(data.name);
      open.set(data.file, names);
    } else if (type === "test:stdout" || type === "test:stderr") {
      if (!data.file) continue;
      // These name the file relative to the working directory, and the
      // test events by its absolute path.
      const file = path.resolve(data.file);
      const lines = output.get(file) ?? [];
      lines.push(...data.message.replace(/\n$/, "").split("\n"));
      output.set(file, lines.slice(-MAX_OUTPUT_LINES));
    } else if (type === "test:fail") {
      const error = data.details?.error;
      // A parent fails because its children did, and a test cancelled
      // because its file died is not news either: the child and the file
      // are the failures worth naming.
      if (error?.failureType === "subtestsFailed" || error?.failureType === "cancelledByParent") continue;
      const names = (open.get(data.file) ?? []).slice(0, data.nesting);
      const fileLevel = data.nesting === 0 && data.file && data.name === path.relative(process.cwd(), data.file);
      // The runner's own location for a test is not source mapped, so
      // under tsx it is a column on line 1 of the transpiled file. The
      // first frame of the stack in the test file is mapped, and it is
      // the line that failed rather than the line the test was declared
      // on. A timeout has no such frame, so its test is found by name.
      const thrown = thrownBy(error);
      const at = data.file && !fileLevel ? (frameIn(thrown, data.file) ?? declaration(data.file, data.name)) : null;
      failures.push({
        package: path.relative(ROOT, process.cwd()) || ".",
        file: data.file ? path.relative(ROOT, data.file) : null,
        line: at ? at.line : sourceMapped(data.file) ? null : (data.line ?? null),
        column: at ? at.column : sourceMapped(data.file) ? null : (data.column ?? null),
        name: [...names, data.name].join(" > "),
        failureType: error?.failureType ?? null,
        error: describeError(thrown),
        output: fileLevel ? relativeToRoot((output.get(data.file) ?? []).join("\n")) : null,
      });
    }
  }

  if (dir && failures.length > 0) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${randomUUID()}.json`), JSON.stringify(failures, null, 2));
  }
}

// The runner wraps what the test threw in ERR_TEST_FAILURE; the cause
// is the assertion, with its diff, or the thrown error.
function thrownBy(error) {
  if (!error) return undefined;
  return error.code === "ERR_TEST_FAILURE" && error.cause !== undefined ? error.cause : error;
}

function frameIn(thrown, file) {
  if (typeof thrown?.stack !== "string") return null;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = thrown.stack.match(new RegExp(`${escaped}:(\\d+):(\\d+)`));
  return match ? { line: Number(match[1]), column: Number(match[2]) } : null;
}

function declaration(file, name) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const quoted = ['"', "'", "`"].map((quote) => quote + name + quote);
  const index = source.split("\n").findIndex((line) => quoted.some((q) => line.includes(q)));
  return index === -1 ? null : { line: index + 1, column: null };
}

// A file tsx compiles: the runner's line and column point into its
// output, not the source, and are worse than none.
function sourceMapped(file) {
  return typeof file === "string" && /\.[cm]?tsx?$/.test(file);
}

function relativeToRoot(text) {
  return text.replaceAll(`${ROOT}${path.sep}`, "");
}

function describeError(thrown) {
  if (thrown === undefined) return "";
  let text;
  if (thrown instanceof Error && typeof thrown.stack === "string") {
    // The stack opens with the message (an assertion's diff included).
    // Frames from Node and from dependencies are noise on a phone, and
    // the cause chain is where a wrapped error says what really failed.
    text = thrown.stack
      .split("\n")
      .filter((line) => !/^\s+at /.test(line) || !/node:|node_modules|<anonymous>\)?$/.test(line))
      .join("\n");
    if (thrown.cause !== undefined) text += `\n[cause]: ${describeError(thrown.cause)}`;
  } else {
    text = typeof thrown === "string" ? thrown : inspect(thrown, { depth: 4, colors: false });
  }
  const lines = relativeToRoot(text).split("\n");
  if (lines.length <= MAX_ERROR_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_ERROR_LINES), `... ${lines.length - MAX_ERROR_LINES} more lines in the log above`].join("\n");
}
