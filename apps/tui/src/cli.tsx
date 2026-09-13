#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app.js";
import { MouseProvider } from "./mouse.js";
import { HELP, parseCliOptions } from "./cli-options.js";
import { redirectTerminalLogs } from "./terminal-log.js";
import {
  runAgents,
  runLogin,
  runMcp,
  runPipeline,
  runRepos,
  runRunner,
  runServe,
  runSessions,
  runSpend,
} from "./headless.js";

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
if (options.command === "update") {
  try {
    const { runUpdate } = await import("./update.js");
    await runUpdate();
  } catch (error) {
    console.error(`Update failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (options.command === "uninstall") {
  try {
    const { runUninstall } = await import("./uninstall.js");
    await runUninstall();
  } catch (error) {
    console.error(`Uninstall failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
} else if (options.command === "serve") {
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
} else if (options.command === "spend") {
  await runSpend(options);
} else if (options.command === "sessions") {
  await runSessions(options);
} else if (options.command === "mcp") {
  await runMcp(options);
} else {
  await runBoard();
}

async function runBoard() {
  const fullScreen = Boolean(process.stdout.isTTY) && process.env.INK_SCREEN_READER !== "true";
  const restoreLogs = fullScreen ? await redirectTerminalLogs(options!.dataDir) : undefined;
  try {
    // Mouse coordinates are relative to the viewport. Keep the app at a stable origin
    // and restore the user's shell screen when it exits.
    const { waitUntilExit } = render(
      <MouseProvider>
        <App options={options!} />
      </MouseProvider>,
      {
        alternateScreen: process.env.INK_SCREEN_READER !== "true",
        patchConsole: !fullScreen,
      },
    );
    await waitUntilExit();
  } finally {
    await restoreLogs?.();
  }
  // The embedded server keeps handles open; leaving is the user's intent.
  process.exit(0);
}
