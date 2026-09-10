import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, createPool } from "@bento/db";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { loadEnv } from "./env.js";

/**
 * The console as the server serves it: the shell, its build id, and
 * the cache rules a stale tab depends on. Nothing here needs a schema,
 * only a database that answers the health ping.
 */
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";

const SHELL = [
  "<!doctype html><html><head>",
  '<meta name="bento-build" content="deadbeef0001">',
  '<script type="module" src="/assets/index-abc123.js"></script>',
  "</head><body><div id=\"root\"></div></body></html>",
].join("");

let pool: ReturnType<typeof createPool>;
let stamped: ReturnType<typeof createApp>;
let unstamped: ReturnType<typeof createApp>;

function contextFor(webDir: string): AppContext {
  return {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: databaseUrl, BENTO_WEB_DIR: webDir } as NodeJS.ProcessEnv),
    db: createDb(pool),
    driver: { provider: "local-process" },
  } as unknown as AppContext;
}

before(async () => {
  pool = createPool(databaseUrl);

  const dir = await mkdtemp(path.join(tmpdir(), "bento-web-shell-"));
  await writeFile(path.join(dir, "index.html"), SHELL);
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "assets", "index-abc123.js"), "export {};\n");
  await writeFile(path.join(dir, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  stamped = createApp(contextFor(dir));

  const plain = await mkdtemp(path.join(tmpdir(), "bento-web-shell-plain-"));
  await writeFile(path.join(plain, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  unstamped = createApp(contextFor(plain));
});

after(async () => {
  await pool?.end();
});

test("every API response names the build the server serves", async () => {
  const health = await stamped.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-bento-build"), "deadbeef0001");
  const body = (await health.json()) as { build?: string };
  assert.equal(body.build, "deadbeef0001");

  // A refusal carries it too: a renamed route answering 404 is the
  // response that most needs to say a deploy happened.
  const missing = await stamped.request("/api/no-such-route");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-bento-build"), "deadbeef0001");
});

test("a shell without a build id sends no header and no field", async () => {
  const health = await unstamped.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-bento-build"), null);
  const body = (await health.json()) as { build?: string };
  assert.equal("build" in body, false);
});

test("the shell is served with no-cache from the root and from client routes", async () => {
  for (const route of ["/", "/settings", "/session/11111111-1111-1111-1111-111111111111"]) {
    const res = await stamped.request(route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, route);
    assert.equal(res.headers.get("cache-control"), "no-cache", route);
    assert.match(await res.text(), /bento-build/, route);
  }
});

test("emitted assets cache forever and a missing one is a 404, not the shell", async () => {
  const chunk = await stamped.request("/assets/index-abc123.js");
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const gone = await stamped.request("/assets/index-oldhash.js");
  assert.equal(gone.status, 404);
  assert.doesNotMatch(gone.headers.get("content-type") ?? "", /text\/html/);
});

test("root files keep their short cache", async () => {
  const icon = await stamped.request("/favicon.svg");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("cache-control"), "public, max-age=3600");
});
