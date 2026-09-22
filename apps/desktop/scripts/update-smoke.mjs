import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { closeElectron } from "./close-electron.mjs";
import { teardownSmoke } from "./teardown-smoke.mjs";

// Real Electron networking, GitHub provider, architecture selection, disk cache,
// and SHA-512 verification against an isolated loopback release service. It never
// asks Squirrel to install or changes the user's profile or installed Bento.
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-update-smoke-"));
let version = "1.2.3";
const payloads = Object.fromEntries(["arm64", "x64"].map(arch => [arch, Buffer.from(`isolated update payload ${arch}`)]));
const metadata = { version, files: Object.entries(payloads).flatMap(([arch, bytes]) => ["zip", "dmg"].map(ext => ({ url: `Bento-${version}-${arch}.${ext}`, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") }))) };
function setVersion(next) {
  for (const file of metadata.files) file.url = file.url.replace(`Bento-${version}-`, `Bento-${next}-`);
  version = next;
  metadata.version = next;
}
let mode = "valid";
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost").pathname;
  requests.push(url);
  if (url === "/api/health") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ mode: "local" }));
  } else if (url.endsWith(".atom")) {
    response.end(`<feed><entry><title>Preview</title><link href="https://github.com/danielpang/bento/releases/tag/v99.0.0-beta.1"/><content>Preview</content></entry><entry><title>Stable</title><link href="https://github.com/danielpang/bento/releases/tag/v${version}"/><content>Stable</content></entry></feed>`);
  } else if (url.endsWith("/latest")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ tag_name: `v${version}` }));
  } else if (url.endsWith("/latest-mac.yml") && mode !== "missing") {
    response.end(JSON.stringify(metadata)); // JSON is valid YAML.
  } else if (url.endsWith(".zip")) {
    const bytes = payloads[url.includes("arm64") ? "arm64" : "x64"];
    response.end(mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes);
  } else { response.writeHead(404); response.end("No release asset"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const host = `127.0.0.1:${server.address().port}`;
const env = { ...process.env, BENTO_DESKTOP_PROFILE: path.join(temporary, "profile") };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
async function closeDesktop(application) {
  const result = await closeElectron(application);
  if (result.timedOutAt) console.warn(`Stopped isolated Electron fixture after ${result.timedOutAt} timed out.`);
}
try {
  // Exercise the shipped native menu with the package's real signing policy.
  desktop = await _electron.launch({ ...(process.env.BENTO_DESKTOP_EXECUTABLE ? { executablePath: process.env.BENTO_DESKTOP_EXECUTABLE, args: [] } : { args: [root] }), env });
  desktop.process().stderr.on("data", bytes => process.stderr.write(bytes));
  const launcher = await desktop.firstWindow();
  await launcher.waitForLoadState("domcontentloaded");
  if (process.env.BENTO_DESKTOP_EXECUTABLE) {
    const runningVersion = await desktop.evaluate(({ app }) => app.getVersion());
    // Keep this smoke useful when a real release passes the original fixture's version.
    setVersion(`${Number(runningVersion.split(".")[0]) + 1}.0.0`);
  }
  console.log("Opened Bento for native update menu verification");
  const menuResult = await desktop.evaluate(async ({ app, Menu, dialog, shell }, { host, packaged }) => {
    const messages = [];
    const urls = [];
    globalThis.updateSmoke = { messages, urls, consent: false };
    dialog.showMessageBox = async options => {
      messages.push(options);
      return { response: globalThis.updateSmoke.consent && options.buttons?.includes("Download Update") ? 1 : 0, checkboxChecked: false };
    };
    shell.openExternal = async url => { urls.push(url); };
    let updateMode;
    if (packaged) {
      // Access the shipped updater through the main-process test inspector.
      // Production has no feed override or testing IPC.
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      updateMode = require(`${app.getAppPath()}/package.json`).bentoUpdateMode;
      if (!["manual", "automatic"].includes(updateMode)) throw new Error(`Unexpected packaged update mode: ${updateMode}`);
      const updater = require("electron-updater").autoUpdater;
      if (updater.autoDownload !== (updateMode === "automatic")) throw new Error("Packaged update policy does not match its manifest or signing identity");
      // Keep downloaded fixture bytes out of the installed app's updater cache.
      Object.defineProperty(updater.app, "baseCachePath", { value: app.getPath("userData") });
      updater.setFeedURL({ provider: "github", owner: "danielpang", repo: "bento", host, protocol: "http" });
    }
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "Check for Updates...");
    if (!item) throw new Error("Missing native Check for Updates menu");
    const waitFor = async predicate => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the update menu");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    item.click();
    await waitFor(() => messages.length);
    if (packaged) {
      const label = updateMode === "automatic" ? "Restart to Update..." : "Check for Updates...";
      await waitFor(() => Menu.getApplicationMenu().items[0].submenu.items.some(item => item.label === label && item.enabled));
      if (urls.length) throw new Error("Later opened a download");
    }
    return { messages, urls, updateMode, arch: process.arch === "arm64" || app.runningUnderARM64Translation ? "arm64" : "x64" };
  }, { host, packaged: Boolean(process.env.BENTO_DESKTOP_EXECUTABLE) });
  if (process.env.BENTO_DESKTOP_EXECUTABLE) {
    const automatic = menuResult.updateMode === "automatic";
    assert.equal(menuResult.messages[0].message, automatic ? `Install Bento ${version}?` : `Bento ${version} is available`);
    assert.match(menuResult.messages[0].detail, automatic ? /Bento will restart/ : /quit Bento with Cmd\+Q/);
    const toast = launcher.locator("#bento-update-toast");
    await toast.waitFor({ state: "visible" });
    assert.ok((await toast.innerText()).includes(version));
    const action = automatic ? "Restart and update" : "Download update";
    assert.equal(await toast.getByRole("button", { name: action }).count(), 1);
    if (automatic) {
      // Exercise the actual restart button, but always decline installation of
      // these checksum fixtures. Native replacement needs two real signed apps.
      const prompts = await desktop.evaluate(() => globalThis.updateSmoke.messages.length);
      await toast.getByRole("button", { name: action }).click();
      await desktop.evaluate(async (_, prompts) => {
        const deadline = Date.now() + 15_000;
        while (globalThis.updateSmoke.messages.length === prompts) {
          if (Date.now() > deadline) throw new Error("Restart button did not ask for consent");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }, prompts);
      assert.equal(await desktop.evaluate(() => globalThis.updateSmoke.messages.length), prompts + 1);
      assert.equal(await desktop.evaluate(({ app }) => {
        const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
        return require("electron-updater").autoUpdater.squirrelDownloadedUpdate;
      }), false);
      assert.equal(requests.filter(url => url.endsWith(".zip")).length, 1);
      assert.ok(requests.some(url => url.endsWith(`-${menuResult.arch}.zip`)));
    }
    for (const theme of ["light", "dark", "navy"]) {
      await launcher.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await toast.screenshot({ path: path.join(temporary, `update-toast-${theme}.png`) });
    }
    const box = await toast.boundingBox();
    const viewportHeight = await launcher.evaluate(() => innerHeight);
    assert.equal(Math.round(box.x), 16);
    assert.equal(Math.round(viewportHeight - box.y - box.height), 16);

    // A newly opened console receives the existing notice through trusted IPC.
    await launcher.locator('input[name="mode"][value="remote"]').check();
    await launcher.locator("#server-url").fill(`http://${host}`);
    const consoleOpened = desktop.waitForEvent("window");
    await launcher.locator("#connect").click();
    const consolePage = await consoleOpened;
    const consoleToast = consolePage.locator("#bento-update-toast");
    await consoleToast.waitFor({ state: "visible" });
    await consoleToast.screenshot({ path: path.join(temporary, "update-toast-console.png") });
    await consoleToast.getByRole("button", { name: "Dismiss update notification" }).click();
    await toast.waitFor({ state: "hidden" });
    await consolePage.reload();
    await consoleToast.waitFor({ state: "hidden" });

    if (!automatic) {
      // A later release brings the notice back; its actual button launches the
      // manual flow without exposing arbitrary download URLs to the renderer.
      setVersion(`${Number(version.split(".")[0]) + 1}.0.0`);
      await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "Check for Updates...").click());
      await consoleToast.waitFor({ state: "visible" });
      await desktop.evaluate(() => { globalThis.updateSmoke.consent = true; });
      await consoleToast.getByRole("button", { name: "Download update" }).click();
      await consoleToast.waitFor({ state: "hidden" });
      const urls = await desktop.evaluate(() => globalThis.updateSmoke.urls);
      assert.deepEqual(urls, [`https://github.com/danielpang/bento/releases/download/v${version}/Bento-${version}-${menuResult.arch}.dmg`]);
      assert.ok(!requests.some(url => /\.(zip|dmg)$/.test(url)), "Manual checks must not use the automatic installer");
    }
    assert.ok(!requests.some(url => url.includes("v99")), "A stable client must not request the prerelease");
    setVersion("1.2.3");
    console.log(`PASS: packaged ${menuResult.updateMode} updates, themed toast, shared dismissal, console reload, and consent. Screenshots: ${temporary}`);
  } else assert.match(menuResult.messages[0].detail, /Development builds/);
  console.log("PASS: native menu follows the development or packaged update policy");
  await closeDesktop(desktop);
  desktop = undefined;

  await writeFile(path.join(temporary, "main.cjs"), `const {app, BrowserWindow} = require('electron'); global.fixtureRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, "package.json"))}); global.loadRuntimeController = () => import(${JSON.stringify(path.join(root, "dist/runtime-controller.js"))}); global.loadUpdates = () => import(${JSON.stringify(path.join(root, "dist/updates.js"))}); app.setPath('userData', ${JSON.stringify(path.join(temporary, "fixture-profile"))}); app.whenReady().then(() => new BrowserWindow({show:false}));`);
  desktop = await _electron.launch({ args: [path.join(temporary, "main.cjs")], env });
  console.log("Opened isolated updater fixture");
  for (const scenario of [
    { name: "apple-silicon", arch: "arm64", rosetta: false, selected: "arm64", mode: "valid" },
    { name: "intel", arch: "x64", rosetta: false, selected: "x64", mode: "valid" },
    { name: "rosetta", arch: "x64", rosetta: true, selected: "arm64", mode: "valid" },
    { name: "manual-arm64", arch: "arm64", manual: true, selected: "arm64", mode: "valid" },
    { name: "manual-x64", arch: "x64", manual: true, selected: "x64", mode: "valid" },
    { name: "manual-rosetta", arch: "x64", rosetta: true, manual: true, selected: "arm64", mode: "valid" },
    { name: "checksum", arch: "arm64", rosetta: false, selected: "arm64", mode: "corrupt" },
    { name: "missing", arch: "arm64", rosetta: false, selected: "arm64", mode: "missing" },
  ]) {
    mode = scenario.mode;
    requests.length = 0;
    const folder = path.join(temporary, scenario.name);
    await mkdir(folder);
    await writeFile(path.join(folder, "update.yml"), "updaterCacheDirName: fixture\n");
    const result = await desktop.evaluate(async ({ autoUpdater: nativeUpdater }, { root, folder, host, scenario }) => {
      const require = globalThis.fixtureRequire;
      const { MacUpdater } = require("electron-updater");
      const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor.js");
      const childProcess = require("node:child_process");
      const originalExec = childProcess.execFileSync;
      const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
      // Simulate hardware detection only. Provider parsing, requests, download,
      // checksums, and the actual MacUpdater implementation remain unmodified.
      Object.defineProperty(process, "arch", { value: scenario.arch, configurable: true });
      childProcess.execFileSync = (command, args, options) => command === "sysctl" ? `sysctl.proc_translated: ${scenario.rosetta ? 1 : 0}` : command === "uname" ? (scenario.arch === "arm64" ? "Darwin ARM64" : "Darwin x86_64") : originalExec(command, args, options);
      const updater = new MacUpdater(undefined, { version: "1.0.0", name: "Bento fixture", isPackaged: true, userDataPath: folder, baseCachePath: folder, appUpdateConfigPath: `${folder}/update.yml`, whenReady: async () => {}, quit: () => { throw new Error("Unexpected quit"); }, onQuit: () => {}, relaunch: () => { throw new Error("Unexpected relaunch"); } });
      updater.httpExecutor = new ElectronHttpExecutor();
      updater.setFeedURL({ provider: "github", owner: "danielpang", repo: "bento", host, protocol: "http" });
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.logger = { info() {}, warn() {}, error() {} };
      let downloaded;
      let updateError;
      updater.on("update-downloaded", info => { downloaded = info.downloadedFile; });
      updater.on("error", error => { updateError = error.code ?? error.message; });
      try {
        if (scenario.manual) {
          const { DesktopUpdates } = await globalThis.loadUpdates();
          const urls = [];
          const errors = [];
          const unexpected = () => { throw new Error("Manual mode attempted automatic installation"); };
          const updates = new DesktopUpdates(updater, { changed() {}, notify: unexpected, message: async (...args) => { errors.push(args); },
            confirmRestart: unexpected, prepareInstall: unexpected, shutdown: unexpected, shutdownFailed: unexpected }, undefined,
          { arch: scenario.arch === "arm64" || scenario.rosetta ? "arm64" : "x64", confirmDownload: async () => true, openDownload: async url => { urls.push(url); } });
          await updates.check(true);
          updates.dispose();
          return { urls, errors, nativeStaged: updater.squirrelDownloadedUpdate };
        }
        const { DesktopUpdates } = await globalThis.loadUpdates();
        const notices = [];
        let restartPrompts = 0;
        const unexpected = () => { throw new Error("Automatic update proceeded without restart consent"); };
        const updates = new DesktopUpdates(updater, {
          changed: () => notices.push(updates.notice), notify() {}, message: unexpected,
          confirmRestart: async () => { restartPrompts++; return false; },
          prepareInstall: unexpected, shutdown: unexpected, shutdownFailed: unexpected,
        });
        await updates.check();
        if (updates.notice) await updates.check(true); // Later must leave the runtime and native installer alone.
        const notice = updates.notice;
        updates.dispose();
        const { readFile } = require("node:fs/promises");
        return { error: updateError, notice, notices, restartPrompts,
          contents: downloaded ? await readFile(downloaded, "utf8") : undefined, nativeStaged: updater.squirrelDownloadedUpdate };
      } catch (error) { return { error: error.code ?? error.message }; }
      finally {
        updater.closeServerIfExists();
        childProcess.execFileSync = originalExec;
        Object.defineProperty(process, "arch", originalArch);
      }
    }, { root, folder, host, scenario });
    if (scenario.manual) {
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.urls, [`https://github.com/danielpang/bento/releases/download/v${version}/Bento-${version}-${scenario.selected}.dmg`]);
      assert.equal(result.nativeStaged, false);
      assert.ok(!requests.some(url => /\.(zip|dmg)$/.test(url)));
    } else if (scenario.mode === "valid") {
      assert.deepEqual(result.notice, { version, action: "restart", busy: false });
      assert.equal(result.restartPrompts, 1);
      assert.deepEqual(result.notices.slice(-3).map(notice => notice?.busy), [false, true, false]);
      assert.equal(result.contents, payloads[scenario.selected].toString());
      assert.equal(result.nativeStaged, false);
      assert.equal(requests.filter(url => url.endsWith(".zip")).length, 1);
    } else if (scenario.mode === "corrupt") assert.match(result.error, /ERR_CHECKSUM_MISMATCH/);
    else assert.equal(result.error, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    assert.ok(!requests.some(url => url.includes("v99")), "A stable client must not request the prerelease");
    console.log(`PASS: real updater ${scenario.name}`);
  }
  const runtimeDirectory = path.join(temporary, "runtime");
  await mkdir(runtimeDirectory);
  await writeFile(path.join(runtimeDirectory, "runtime.js"), `let forced = false; process.parentPort.on('message', ({data}) => { if(data.type === 'start') { forced = data.settings.serverUrl === 'forced'; process.parentPort.postMessage({type:'ready', url:'http://127.0.0.1:12345'}); } else if(data.type === 'stop' && !forced) setTimeout(() => process.exit(0), 100); }); setInterval(() => {}, 1000);`);
  const stopped = await desktop.evaluate(async (_, directory) => {
    const { RuntimeController } = await globalThis.loadRuntimeController();
    const runtime = new RuntimeController(directory, () => {}, () => { throw new Error("Unexpected runtime failure"); });
    const results = [];
    for (const kind of ["graceful", "forced", "replacement"]) {
      await runtime.start({ mode: "local", serverUrl: kind });
      let exited = false;
      runtime.child.once("exit", () => { exited = true; });
      const first = runtime.stop();
      const second = runtime.stop();
      await Promise.all([first, second]);
      results.push({ kind, exited, cleared: runtime.child === undefined });
    }
    return results;
  }, runtimeDirectory);
  assert.ok(stopped.every(result => result.exited && result.cleared));
  console.log("PASS: graceful and forced utility process shutdown wait for exit before replacement");
  console.log(`PASS: native menu and update service. Isolated fixtures: ${temporary}`);
} finally {
  if (desktop) await closeDesktop(desktop);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
await teardownSmoke();
