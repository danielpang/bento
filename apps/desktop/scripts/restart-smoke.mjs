import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { createPool } from "../../../packages/db/dist/index.js";
import { closeElectron } from "./close-electron.mjs";

// Changing a launcher setting while local Bento runs restarts it with the new
// settings. Uses real Postgres and the real utility process, in a throwaway
// profile and database.
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-desktop-restart-"));
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5439/app";
const databaseName = `desktop_restart_${Date.now()}`;
const databaseUrl = new URL(baseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = createPool(baseUrl);
let desktop;

const flags = (page) => page.evaluate(async () => (await fetch("/api/flags")).json());
const answerRestart = (response) => desktop.evaluate(({ dialog }, response) => { dialog.showMessageBox = async () => ({ response, checkboxChecked: false }); }, response);
const openSettings = async (launcher) => {
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === "Connection Settings...").click());
  await launcher.locator("#local-running-note").waitFor();
};
const startLabel = (launcher) => launcher.locator("#start").textContent();

try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const env = { ...process.env, BENTO_DESKTOP_PROFILE: path.join(temporary, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ args: [root], env, timeout: 30_000 });
  desktop.process().stderr.on("data", (bytes) => process.stderr.write(bytes));
  const launcher = await desktop.firstWindow();
  await launcher.locator("summary").click();
  await launcher.locator("#data-dir").fill(path.join(temporary, "state"));
  await launcher.locator("#database-url").fill(databaseUrl.href);
  await launcher.locator("#sandbox").selectOption("local-process");
  let opened = desktop.waitForEvent("window", { timeout: 90_000 });
  await launcher.getByRole("button", { name: "Start", exact: true }).click();
  let page = await opened;
  await page.waitForLoadState("domcontentloaded");
  assert.equal((await flags(page)).betaTesters, false);

  await openSettings(launcher);
  assert.equal(await launcher.locator("#beta-features").isDisabled(), false);
  assert.equal(await startLabel(launcher), "Start");
  await launcher.locator("#beta-features").check();
  assert.equal(await startLabel(launcher), "Restart to save these settings");
  await launcher.locator("#beta-features").uncheck();
  assert.equal(await startLabel(launcher), "Start");
  await launcher.locator("#beta-features").check();
  console.log("PASS: settings stay editable and Start names the restart");

  await answerRestart(1);
  await launcher.locator("#start").click();
  await launcher.waitForTimeout(500);
  assert.equal(page.isClosed(), false);
  assert.equal((await flags(page)).betaTesters, false);
  console.log("PASS: declining the confirmation restarts nothing");

  await answerRestart(0);
  let closed = page.waitForEvent("close", { timeout: 30_000 });
  await launcher.locator("#start").click();
  await launcher.locator("#cancel").click();
  await closed;
  await launcher.getByText("Choose where Bento runs.").waitFor({ timeout: 30_000 });
  assert.equal(desktop.windows().length, 1);
  console.log("PASS: cancel during a restart starts nothing");

  opened = desktop.waitForEvent("window", { timeout: 90_000 });
  await launcher.locator("#start").click();
  page = await opened;
  await page.waitForLoadState("domcontentloaded");
  assert.equal((await flags(page)).betaTesters, true);
  await openSettings(launcher);
  assert.equal(await launcher.locator("#beta-features").isChecked(), true);
  assert.equal(await startLabel(launcher), "Start");
  console.log("PASS: the restart runs local Bento with the new settings");
} finally {
  if (desktop) await closeElectron(desktop).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => {});
  await admin.end();
}
