import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { createPool } from "../../../packages/db/dist/index.js";
import { startServer } from "../../server/dist/lib.js";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-desktop-auth-"));
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5439/app";
const databaseName = `desktop_auth_${Date.now()}`;
const databaseUrl = new URL(baseUrl); databaseUrl.pathname = `/${databaseName}`;
const admin = createPool(baseUrl);
let server;
let desktop;
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, BENTO_DESKTOP_PROFILE: path.join(temporary, "profile") };
delete env.ELECTRON_RUN_AS_NODE;
async function post(route, body, token) {
  const response = await fetch(`${origin}${route}`, { method: "POST", headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function launch() {
  const application = await _electron.launch({ ...(process.env.BENTO_DESKTOP_EXECUTABLE ? { executablePath: process.env.BENTO_DESKTOP_EXECUTABLE, args: [] } : { args: [root] }), env });
  application.process().stderr.on("data", bytes => process.stderr.write(bytes));
  // The real device endpoints are exercised below. Suppress only the OS browser
  // launch so this automated test does not open a synthetic account in Safari.
  await application.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.desktopExternalUrl = url; }; });
  return application;
}
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  server = await startServer({ migrate: true, quiet: true, env: {
    PORT: String(port), BENTO_HOST: "127.0.0.1", BENTO_MODE: "multi", DATABASE_URL: databaseUrl.href,
    BENTO_DATA_DIR: path.join(temporary, "server"), BENTO_SANDBOX_DRIVER: "local-process",
    BENTO_SECRET_KEY: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_URL: origin, BENTO_TRUSTED_ORIGINS: origin, BENTO_REQUIRE_EMAIL_VERIFICATION: "false",
    POSTHOG_API_KEY: "", BENTO_CLOUD_MODULE: "",
  } });
  const signedUp = await post("/api/auth/sign-up/email", { name: "Desktop Test", email: "desktop@example.test", password: "desktop-test-password-123" });
  const token = signedUp.headers.get("set-auth-token");
  assert.ok(token);
  const organization = await (await post("/api/auth/organization/create", { name: "Desktop team", slug: "desktop-test" }, token)).json();
  await post("/api/auth/organization/set-active", { organizationId: organization.id }, token);
  desktop = await launch();
  let launcher = await desktop.firstWindow();
  await launcher.locator('input[value="remote"]').check();
  await launcher.locator("#server-url").fill(origin);
  await launcher.getByRole("button", { name: "Open Bento", exact: true }).click();
  await launcher.locator("#user-code").waitFor({ state: "visible" });
  const code = (await launcher.locator("#user-code").innerText()).trim();
  assert.ok(code.length > 3);
  const claim = await fetch(`${origin}/api/auth/device?user_code=${encodeURIComponent(code)}`, { headers: { authorization: `Bearer ${token}` } });
  assert.ok(claim.ok);
  const consolePromise = desktop.waitForEvent("window", { timeout: 30_000 });
  await post("/api/auth/device/approve", { userCode: code }, token);
  let page = await consolePromise;
  await page.waitForLoadState("domcontentloaded");
  const auth = await page.evaluate(async () => (await fetch("/api/auth/get-session")).json());
  assert.equal(auth.user.email, "desktop@example.test");
  // The device session must be able to select a team through the unchanged
  // better-auth client. This catches CSRF, origin, and bearer proxy mistakes.
  const selected = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }) });
    return response.status;
  }, organization.id);
  assert.equal(selected, 200);
  const projects = await page.evaluate(async () => (await fetch("/api/projects")).status);
  assert.equal(projects, 200);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.bentoDesktop).sort()), ["chooseDirectory", "connection", "openIntegration", "settings"]);
  await page.evaluate(() => window.bentoDesktop.openIntegration("github"));
  assert.equal(await desktop.evaluate(() => globalThis.desktopExternalUrl), `${origin}/settings?tab=github`);
  assert.equal(await page.evaluate(async () => { try { await window.bentoDesktop.openIntegration("https://example.com"); return false; } catch { return true; } }), true);
  console.log("PASS: actual device login, bearer session, organization selection, and tenant API");
  const encrypted = await readFile(path.join(temporary, "profile/connections.enc"));
  assert.equal(encrypted.includes(Buffer.from(token)), false);
  if (auth.session.token) assert.equal(encrypted.includes(Buffer.from(auth.session.token)), false);
  await desktop.close(); desktop = undefined;
  desktop = await launch();
  launcher = await desktop.firstWindow();
  page = desktop.windows().find(window => window.url().startsWith(origin)) ?? await desktop.waitForEvent("window", { timeout: 20_000 });
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.email), "desktop@example.test");
  const logout = await page.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  assert.equal(logout, 200);
  const afterLogout = await page.evaluate(async () => (await fetch("/api/projects")).status);
  assert.equal(afterLogout, 401);
  console.log("PASS: encrypted login survives restart and sign-out revokes access");
} finally {
  await desktop?.close().catch(() => {});
  await server?.stop();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
}
