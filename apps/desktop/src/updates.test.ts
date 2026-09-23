import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DesktopUpdates, manualDownloadUrl, type ManualUpdateOptions, type UpdateDriver, type UpdateUi } from "./updates.js";
import type { UpdateInfo } from "electron-updater";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(disabledReason?: string, manual?: ManualUpdateOptions) {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const messages: string[] = [];
  let checks = 0;
  const result = deferred<Awaited<ReturnType<UpdateDriver["checkForUpdates"]>>>();
  const driver = Object.assign(emitter, {
    autoDownload: false, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    checkForUpdates: () => { checks++; return result.promise; },
    quitAndInstall: () => { calls.push("install"); },
  }) as unknown as UpdateDriver;
  const ui: UpdateUi = {
    changed: () => {}, notify: () => { calls.push("notify"); },
    message: async (message, detail) => { messages.push(`${message}: ${detail}`); },
    confirmRestart: async () => false,
    prepareInstall: async () => { calls.push("verify"); },
    shutdown: async () => { calls.push("shutdown"); },
    shutdownFailed: () => { calls.push("recover"); },
  };
  const updates = new DesktopUpdates(driver, ui, disabledReason, manual);
  const downloaded = () => emitter.emit("update-downloaded", { version: "1.2.3" });
  return { updates, emitter, driver, ui, calls, messages, result, downloaded, checks: () => checks };
}

test("background downloads never restart or stage an update without consent", async () => {
  const f = fixture();
  assert.equal(f.driver.autoDownload, true);
  assert.equal(f.driver.autoInstallOnAppQuit, false);
  assert.equal(f.driver.allowPrerelease, false);
  assert.equal(f.driver.allowDowngrade, false);
  const checking = f.updates.check();
  f.emitter.emit("update-available", { version: "1.2.3" });
  f.downloaded();
  f.result.resolve(null);
  await checking;
  await f.updates.check(true); // Later is the default answer.
  assert.deepEqual(f.calls, ["notify"]);
  assert.equal(f.updates.menu.label, "Restart to Update...");
});

function manualRelease(arch = "arm64") {
  const info = { version: "1.2.3", tag: "v1.2.3", path: "unused.zip", sha512: "checksum", releaseDate: "2026-09-20T00:00:00Z",
    files: [{ url: `Bento-1.2.3-${arch}.dmg`, sha512: "checksum" }] };
  return { isUpdateAvailable: true, updateInfo: info, versionInfo: info, downloadPromise: null };
}

test("manual background checks show a toast, while downloads still require consent", async () => {
  const urls: string[] = [];
  let consent = false;
  const f = fixture(undefined, { arch: "arm64", confirmDownload: async () => consent, openDownload: async url => { urls.push(url); } });
  assert.equal(f.driver.autoDownload, false);
  assert.equal(f.driver.autoInstallOnAppQuit, false);
  f.updates.start();
  const background = f.updates.check();
  f.result.resolve(manualRelease());
  await background;
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.updates.notice, { version: "1.2.3", action: "download", busy: false });
  await f.updates.check(true); // Later retains the toast without opening a browser.
  assert.deepEqual(urls, []);
  consent = true;
  await f.updates.check(true);
  assert.deepEqual(urls, ["https://github.com/danielpang/bento/releases/download/v1.2.3/Bento-1.2.3-arm64.dmg"]);
  assert.deepEqual(f.calls, []); // No signature staging, notification, shutdown, or installation.
  assert.equal(f.updates.menu.label, "Check for Updates...");
  assert.equal(f.updates.notice, null);
  f.updates.dispose();
});

test("dismissing an update is shared across windows and only a new version returns", async () => {
  const f = fixture(undefined, { arch: "arm64", confirmDownload: async () => false, openDownload: async () => {} });
  f.result.resolve(manualRelease());
  await f.updates.check();
  f.updates.dismissNotice();
  assert.equal(f.updates.notice, null);
  await f.updates.check();
  assert.equal(f.updates.notice, null);
  const next = manualRelease();
  next.updateInfo.version = "1.2.4";
  next.updateInfo.tag = "v1.2.4";
  next.updateInfo.files[0]!.url = "Bento-1.2.4-arm64.dmg";
  f.driver.checkForUpdates = async () => next;
  await f.updates.check();
  assert.equal(f.updates.notice?.version, "1.2.4");
  f.driver.checkForUpdates = async () => ({ ...next, isUpdateAvailable: false });
  await f.updates.check();
  assert.equal(f.updates.notice, null);
});

test("repeated manual checks share one version lookup and confirmation", async () => {
  const consent = deferred<boolean>();
  let prompts = 0;
  const f = fixture(undefined, { arch: "x64", confirmDownload: () => { prompts++; return consent.promise; }, openDownload: async () => {} });
  const first = f.updates.check(true);
  f.result.resolve(manualRelease("x64"));
  await new Promise(resolve => setImmediate(resolve));
  const repeated = f.updates.check(true);
  consent.resolve(false);
  await Promise.all([first, repeated]);
  assert.equal(f.checks(), 1);
  assert.equal(prompts, 1);
});

test("manual mode reports current versions and recovers from a browser failure", async () => {
  let fail = true;
  const urls: string[] = [];
  const f = fixture(undefined, { arch: "arm64", confirmDownload: async () => true, openDownload: async url => {
    if (fail) throw new Error("Browser could not open");
    urls.push(url);
  } });
  f.result.resolve({ ...manualRelease(), isUpdateAvailable: false });
  await f.updates.check(true);
  assert.match(f.messages[0]!, /up to date/);
  f.driver.checkForUpdates = async () => manualRelease();
  await f.updates.check(true);
  assert.match(f.messages[1]!, /Could not check for updates/);
  fail = false;
  await f.updates.check(true);
  assert.equal(urls.length, 1);
  assert.deepEqual(f.calls, []);
});

test("manual installer selection requires an exact stable release and matching architecture", () => {
  const info = manualRelease("x64").updateInfo;
  assert.equal(manualDownloadUrl(info, "x64"), "https://github.com/danielpang/bento/releases/download/v1.2.3/Bento-1.2.3-x64.dmg");
  assert.equal(manualDownloadUrl({ ...info, tag: "1.2.3" } as UpdateInfo, "x64"), "https://github.com/danielpang/bento/releases/download/1.2.3/Bento-1.2.3-x64.dmg");
  assert.throws(() => manualDownloadUrl(info, "arm64"));
  for (const patch of [
    { version: "1.2.3-beta.1" }, { tag: "v1.2.4" }, { tag: "../../other" },
    { files: [{ url: "https://example.com/installer.dmg", sha512: "checksum" }] },
  ]) assert.throws(() => manualDownloadUrl({ ...info, ...patch }, "x64"));
});

test("a manual check joins an automatic download and reports its result once", async () => {
  const f = fixture();
  const background = f.updates.check();
  const manual = f.updates.check(true);
  const repeated = f.updates.check(true);
  f.result.resolve(null);
  await Promise.all([background, manual, repeated]);
  assert.equal(f.checks(), 1);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0]!, /up to date/);
});

test("restart waits for native validation and complete local shutdown", async () => {
  const f = fixture();
  const verified = deferred();
  const stopped = deferred();
  f.ui.confirmRestart = async () => true;
  f.ui.prepareInstall = () => { f.calls.push("verify"); return verified.promise; };
  f.ui.shutdown = () => { f.calls.push("shutdown"); return stopped.promise; };
  f.downloaded();
  const install = f.updates.check(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["notify", "verify"]);
  assert.equal(f.updates.notice?.busy, true);
  await f.updates.check(true);
  verified.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["notify", "verify", "shutdown"]);
  stopped.resolve();
  await install;
  assert.deepEqual(f.calls, ["notify", "verify", "shutdown", "install"]);
});

test("all windows disable the restart notice during consent and recover after Later", async () => {
  const f = fixture();
  const consent = deferred<boolean>();
  const busy: boolean[] = [];
  let prompts = 0;
  f.ui.changed = () => { busy.push(f.updates.notice?.busy ?? false); };
  f.ui.confirmRestart = () => { prompts++; return consent.promise; };
  f.downloaded();
  const first = f.updates.check(true);
  await f.updates.check(true);
  assert.equal(prompts, 1);
  assert.equal(f.updates.notice?.busy, true);
  consent.resolve(false);
  await first;
  assert.deepEqual(busy, [false, true, false]);
  assert.equal(f.updates.notice?.busy, false);
  assert.ok(!f.calls.includes("verify"));
});

test("native signature failures preserve the local runtime and allow retry", async () => {
  const f = fixture();
  f.ui.confirmRestart = async () => true;
  f.ui.prepareInstall = async () => { throw new Error("Signature does not match"); };
  f.downloaded();
  await f.updates.check(true);
  assert.ok(!f.calls.includes("shutdown"));
  assert.ok(!f.calls.includes("install"));
  assert.equal(f.updates.menu.label, "Restart to Update...");
  f.ui.prepareInstall = async () => { f.calls.push("verify"); };
  await f.updates.check(true);
  assert.deepEqual(f.calls.slice(-3), ["verify", "shutdown", "install"]);
});

test("offline and missing metadata failures are quiet in background and retryable", async () => {
  const f = fixture();
  f.result.reject(Object.assign(new Error("404"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }));
  await f.updates.check();
  assert.equal(f.messages.length, 0);
  await f.updates.check(true);
  assert.match(f.messages[0]!, /not available from the release service yet/);
  f.driver.checkForUpdates = async () => null;
  await f.updates.check(true);
  assert.match(f.messages[1]!, /up to date/);
});

test("development builds and disposed controllers never contact the feed", async () => {
  const f = fixture("Install a signed release.");
  f.updates.start();
  await f.updates.check();
  await f.updates.check(true);
  assert.equal(f.checks(), 0);
  assert.match(f.messages[0]!, /Install a signed release/);
  const active = fixture();
  active.updates.dispose();
  await active.updates.check(true);
  assert.equal(active.checks(), 0);
});
