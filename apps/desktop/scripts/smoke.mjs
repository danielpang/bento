import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { createPool } from "../../../packages/db/dist/index.js";

// This uses real Postgres and a real Electron utility process. It creates and
// removes its own database, and never touches the user's projects or profile.
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-desktop-smoke-"));
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5439/app";
const databaseName = `desktop_smoke_${Date.now()}`;
const databaseUrl = new URL(baseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = createPool(baseUrl);
let database;
let desktop;
let page;
const errors = [];
// A real foreign origin proves previews can use external scripts while their
// requests to the authenticated backend remain blocked.
const assets = createServer((_request, response) => {
  response.setHeader("content-type", "text/javascript");
  response.end("document.body.dataset.external = 'loaded'");
});
await new Promise(resolve => assets.listen(0, "127.0.0.1", resolve));
const assetOrigin = `http://127.0.0.1:${assets.address().port}`;

async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const result = await page.evaluate(async ({ route, body, method }) => {
    const response = await fetch(route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.text() };
  }, { route, body, method });
  assert.ok(result.status < 400, `${method} ${route}: ${result.status} ${result.body}`);
  return result.body ? JSON.parse(result.body) : null;
}

try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  database = createPool(databaseUrl.href);
  const repository = path.join(temporary, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
  await writeFile(path.join(repository, "README.md"), "# Desktop smoke test\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Desktop Test", "-c", "user.email=desktop@example.test", "commit", "-m", "Initial fixture"], { stdio: "ignore" });
  const env = { ...process.env, BENTO_DESKTOP_PROFILE: path.join(temporary, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({
    ...(process.env.BENTO_DESKTOP_EXECUTABLE ? { executablePath: process.env.BENTO_DESKTOP_EXECUTABLE, args: [] } : { args: [root] }),
    env, timeout: 30_000,
  });
  desktop.process().stderr.on("data", bytes => process.stderr.write(bytes));
  desktop.process().stdout.on("data", bytes => process.stdout.write(bytes));
  const launcher = await desktop.firstWindow();
  await launcher.getByRole("heading", { name: "Where do you want to work?" }).waitFor();
  await launcher.locator("summary").click();
  await launcher.locator("#data-dir").fill(path.join(temporary, "state"));
  await launcher.locator("#database-url").fill(databaseUrl.href);
  await launcher.locator("#sandbox").selectOption(process.env.BENTO_DESKTOP_SANDBOX ?? "local-process");
  await launcher.screenshot({ path: path.join(temporary, "connection.png") });
  const consolePromise = desktop.waitForEvent("window", { timeout: 60_000 });
  await launcher.getByRole("button", { name: "Open Bento", exact: true }).click();
  page = await consolePromise;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Renderer:", message.text()); });
  page.on("response", response => { if (response.url().endsWith("/events")) console.log("SSE response", response.status()); });
  await page.waitForLoadState("domcontentloaded");
  assert.equal((await api("/api/health")).mode, "local");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.bentoDesktop?.chooseDirectory), "function");
  console.log("PASS: local utility process, migrations, API, and isolated renderer");

  const project = await api("/api/projects", { name: "Desktop smoke", localPath: repository });
  await page.reload();
  await page.getByRole("button", { name: "New card", exact: true }).waitFor();
  await page.getByRole("button", { name: "New card", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Created in Electron");
  await page.getByRole("textbox", { name: /^Description/ }).fill("A real desktop request persisted in Postgres.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Created in Electron", { exact: true }).first().waitFor();
  const rows = await database.query("SELECT id, title FROM features WHERE project_id = $1 AND title = $2", [project.id, "Created in Electron"]);
  assert.equal(rows.rowCount, 1);
  console.log("PASS: card created through UI and read back from Postgres");

  const origin = new URL(page.url()).origin;
  const browserSettings = await fetch(`${origin}/settings?tab=mcp`);
  assert.ok(browserSettings.ok);
  assert.ok((await browserSettings.text()).includes('id="root"'));
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, origin);
  console.log("PASS: browser integration settings and local MCP callback origin");
  const response = await fetch(`${origin}/api/features`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, title: "Arrived over SSE", description: "Created outside the renderer." }) });
  assert.equal(response.status, 201);
  const streamedCard = await response.json();
  // Creation currently does not emit a board event in the shared server. A
  // stage/status transition does, which exercises the real SSE contract.
  const finished = await fetch(`${origin}/api/features/${streamedCard.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok(finished.ok, await finished.text());
  await page.getByText("Arrived over SSE", { exact: true }).first().waitFor({ timeout: 15_000 });
  console.log("PASS: live board updates through the streaming protocol proxy");

  // Historical artifact fixture. No active run is inserted or agent spawned.
  const stage = (await database.query("SELECT s.id, s.slug, s.name, s.default_agent_profile_id FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.project_id = $1 ORDER BY s.position LIMIT 1", [project.id])).rows[0];
  const run = (await database.query("INSERT INTO agent_runs (feature_id, stage_id, agent_profile_id, status, prompt) VALUES ($1, $2, $3, 'succeeded', 'Historical desktop fixture') RETURNING id", [rows.rows[0].id, stage.id, stage.default_agent_profile_id])).rows[0];
  const html = `<h1>Isolated artifact</h1><script src="${assetOrigin}/preview.js"></script><script>document.body.dataset.bridge = typeof window.bentoDesktop; fetch('${origin}/api/projects').then(r => document.body.dataset.api = r.status).catch(() => document.body.dataset.api = 'blocked');</script>`;
  const artifact = (await database.query("INSERT INTO run_artifacts (run_id, feature_id, stage_slug, stage_name, path, kind, mime, size, content) VALUES ($1,$2,$3,$4,'preview.html','html','text/html',$5,$6) RETURNING id", [run.id, rows.rows[0].id, stage.slug, stage.name, Buffer.byteLength(html), html])).rows[0];
  await page.goto(`${origin}/artifact/${artifact.id}`);
  const frameElement = page.locator("iframe");
  await frameElement.waitFor();
  assert.equal(await frameElement.getAttribute("sandbox"), "allow-scripts");
  const frame = page.frameLocator("iframe").frameLocator("iframe");
  assert.equal(await page.frameLocator("iframe").locator("iframe").getAttribute("sandbox"), "allow-scripts");
  await frame.getByRole("heading", { name: "Isolated artifact" }).waitFor();
  await frame.locator("body[data-api]").waitFor();
  assert.equal(await frame.locator("body").getAttribute("data-external"), "loaded");
  assert.equal(await frame.locator("body").getAttribute("data-bridge"), "undefined");
  assert.ok(["blocked", "403"].includes(await frame.locator("body").getAttribute("data-api")));
  const downloaded = path.join(temporary, "download.html");
  await desktop.evaluate(({ BrowserWindow }, { origin, downloaded }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(origin));
    globalThis.desktopSmokeDownload = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native download did not finish")), 15_000);
      window.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(downloaded);
        item.once("done", (_event, state) => { clearTimeout(timeout); resolve(state); });
      });
    });
  }, { origin, downloaded });
  await page.getByRole("link", { name: "Download", exact: true }).click();
  assert.equal(await desktop.evaluate(() => globalThis.desktopSmokeDownload), "completed");
  assert.equal(await readFile(downloaded, "utf8"), html);
  console.log("PASS: artifact scripts run without bridge or API access; download bytes match");

  const markdown = '# Shared renderer\n\n```mermaid\nflowchart LR\n  A[Desktop] --> B[Agent]\n```';
  const diagram = (await database.query("INSERT INTO run_artifacts (run_id, feature_id, stage_slug, stage_name, path, kind, mime, size, content) VALUES ($1,$2,$3,$4,'diagram.md','markdown','text/markdown',$5,$6) RETURNING id", [run.id, rows.rows[0].id, stage.slug, stage.name, Buffer.byteLength(markdown), markdown])).rows[0];
  await page.goto(`${origin}/artifact/${diagram.id}`);
  await page.getByRole("heading", { name: "Shared renderer" }).waitFor();
  await page.locator(".mermaid-diagram svg").waitFor();
  console.log("PASS: Markdown and dynamically loaded Mermaid diagrams");

  for (const route of ["/sessions", "/settings", "/spend", "/changelog", "/"]) {
    await page.goto(`${origin}${route}`);
    await page.waitForFunction(() => document.getElementById("root")?.innerText.trim().length > 60);
    assert.ok(!(await page.locator("body").innerText()).includes("Something went wrong"), route);
  }
  await page.screenshot({ path: path.join(temporary, "board.png") });
  assert.deepEqual(errors, []);
  const encrypted = await readFile(path.join(temporary, "profile/connections.enc"));
  assert.equal(encrypted.includes(Buffer.from(databaseUrl.href)), false);
  console.log("PASS: shared routes and encrypted connection settings");
  await page.evaluate(() => localStorage.setItem("bento-theme", "dark"));
  await desktop.close(); desktop = undefined;
  desktop = await _electron.launch({
    ...(process.env.BENTO_DESKTOP_EXECUTABLE ? { executablePath: process.env.BENTO_DESKTOP_EXECUTABLE, args: [] } : { args: [root] }),
    env, timeout: 30_000,
  });
  await desktop.firstWindow();
  page = desktop.windows().find(window => window.url().startsWith(origin)) ?? await desktop.waitForEvent("window", { timeout: 60_000 });
  await page.waitForURL(`${origin}/`);
  await page.waitForLoadState("domcontentloaded");
  assert.equal(await page.evaluate(() => localStorage.getItem("bento-theme")), "dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByText("Created in Electron", { exact: true }).first().waitFor();
  console.log("PASS: local restart retains origin, appearance, and project data");
  console.log(`Desktop smoke passed. Screenshots: ${temporary}`);
} catch (error) {
  console.error(`Desktop smoke failed. Diagnostics: ${temporary}`);
  if (page) await page.screenshot({ path: path.join(temporary, "failure.png"), timeout: 5000 }).catch(() => {});
  for (const window of desktop?.windows() ?? []) console.error(window.url(), (await window.locator("body").innerText().catch(() => "")).slice(0, 2000));
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  await database?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
  assets.closeAllConnections();
  await new Promise(resolve => assets.close(resolve));
}
