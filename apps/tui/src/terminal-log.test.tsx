import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redirectTerminalLogs } from "./terminal-log.js";

test("full-screen background logs go to a private file and restore the console on exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-terminal-log-"));
  const previous = globalThis.console;
  try {
    const restore = await redirectTerminalLogs(dir);
    try {
      assert.equal(console.timeStamp, previous.timeStamp);
      console.log("sandbox cleaned up");
      console.warn("warning", { run: "test" });
      console.error(new Error("test failure"));
    } finally {
      await restore();
    }
    assert.equal(globalThis.console, previous);
    const filename = path.join(dir, "logs", "tui.log");
    const output = await readFile(filename, "utf8");
    assert.match(output, /sandbox cleaned up/);
    assert.match(output, /warning.*test/);
    assert.match(output, /Error: test failure/);
    if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const restoreAgain = await redirectTerminalLogs(dir);
    console.log("next session");
    await restoreAgain();
    assert.match(await readFile(filename, "utf8"), /sandbox cleaned up[\s\S]*next session/);
  } finally {
    globalThis.console = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
