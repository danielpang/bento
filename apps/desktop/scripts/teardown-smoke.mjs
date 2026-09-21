import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright";
import { closeElectron } from "./close-electron.mjs";

/** Real Electron fixtures prove the deadline covers both inspector and close waits. */
export async function teardownSmoke() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-teardown-smoke-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const kind of ["delayed", "before-quit", "will-quit"]) {
    const entry = path.join(temporary, `${kind}.cjs`);
    await writeFile(entry, `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(temporary, kind))});
      if (${JSON.stringify(kind)} === 'delayed') {
        app.once('before-quit', event => { event.preventDefault(); setTimeout(() => app.quit(), 150); });
      } else app.on(${JSON.stringify(kind)}, event => event.preventDefault());
      app.whenReady().then(() => {
        global.fixtureWindow = new BrowserWindow({show:false});
        void global.fixtureWindow.loadURL('data:text/html,Teardown fixture');
      });`);
    const application = await _electron.launch({ args: [entry], env });
    const child = application.process();
    try {
      await application.firstWindow({ timeout: 15_000 });
      const result = await closeElectron(application, { timeoutMs: kind === "delayed" ? 5_000 : 500 });
      assert.equal(result.forced, kind !== "delayed");
      if (kind !== "delayed") assert.equal(result.timedOutAt, kind === "before-quit" ? "quit" : "close");
      assert.ok(child.exitCode !== null || child.signalCode !== null, "The owned fixture must exit before teardown returns");
      console.log(`PASS: Electron teardown ${kind}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await teardownSmoke();
