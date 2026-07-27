#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app.js";
import { HELP, parseCliOptions } from "./cli-options.js";
import { runAgents, runLogin, runPipeline, runRepos, runRunner, runServe } from "./headless.js";

let options;
try {
  options = parseCliOptions(process.argv.slice(2));
} catch (err) {
  // Just the problem and a pointer: dumping the full help scrolled the
  // actual message out of view.
  console.error(`${(err as Error).message}`);
  console.error("Run bento --help for usage.");
  process.exit(2);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (options.version) {
  const { createRequire } = await import("node:module");
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

// Headless commands exist so another application can supervise the
// stack: the desktop app spawns these and reads their status lines.
if (options.command === "serve") {
  await runServe(options);
} else if (options.command === "runner") {
  await runRunner(options);
} else if (options.command === "login") {
  await runLogin(options);
} else if (options.command === "repos") {
  await runRepos(options);
} else if (options.command === "agents") {
  await runAgents(options);
} else if (options.command === "pipeline") {
  await runPipeline(options);
} else {
  await runBoard();
}

async function runBoard() {
  const { waitUntilExit } = render(<App options={options!} />);
  await waitUntilExit();
  // The embedded server keeps handles open; leaving is the user's intent.
  process.exit(0);
}
