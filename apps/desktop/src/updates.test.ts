import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DesktopUpdates, type UpdateDriver, type UpdateUi } from "./updates.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(disabledReason?: string) {
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
  const updates = new DesktopUpdates(driver, ui, disabledReason);
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
  await f.updates.check(true);
  verified.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["notify", "verify", "shutdown"]);
  stopped.resolve();
  await install;
  assert.deepEqual(f.calls, ["notify", "verify", "shutdown", "install"]);
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
