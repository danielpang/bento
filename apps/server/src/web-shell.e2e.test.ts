import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, createPool } from "@bento/db";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { loadEnv } from "./env.js";

/**
 * The console as the server serves it: the shell, its build id, and
 * the cache rules a stale tab depends on. Needs only a database that
 * answers the health ping.
 */
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";

const shellFor = (build: string) =>
  [
    "<!doctype html><html><head>",
    `<meta name="bento-build" content="${build}">`,
    '<script type="module" src="/assets/index-abc123.js"></script>',
    '</head><body><div id="root"></div></body></html>',
  ].join("");

let pool: ReturnType<typeof createPool>;
let dir: string;
let plain: string;
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

  dir = await mkdtemp(path.join(tmpdir(), "bento-web-shell-"));
  await writeFile(path.join(dir, "index.html"), shellFor("deadbeef0001"));
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "assets", "index-abc123.js"), "export {};\n");
  await writeFile(path.join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  stamped = createApp(contextFor(dir));

  plain = await mkdtemp(path.join(tmpdir(), "bento-web-shell-plain-"));
  await writeFile(path.join(plain, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  unstamped = createApp(contextFor(plain));
});

after(async () => {
  await pool?.end();
  await rm(dir, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
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

test("the shell is served with no-cache and its build as the ETag, on every path that reaches it", async () => {
  for (const route of ["/", "/index.html", "/settings", "/session/11111111-1111-1111-1111-111111111111"]) {
    const res = await stamped.request(route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, route);
    assert.equal(res.headers.get("cache-control"), "no-cache", route);
    assert.equal(res.headers.get("etag"), '"deadbeef0001"', route);
    assert.match(await res.text(), /bento-build/, route);
  }
  const fresh = await stamped.request("/", { headers: { "if-none-match": '"deadbeef0001"' } });
  assert.equal(fresh.status, 304);
});

test("a rebuild under a running server is served, and the header follows it", async () => {
  const dir2 = await mkdtemp(path.join(tmpdir(), "bento-web-shell-rebuild-"));
  try {
    await writeFile(path.join(dir2, "index.html"), shellFor("build0001"));
    const app = createApp(contextFor(dir2));
    assert.equal((await app.request("/api/health")).headers.get("x-bento-build"), "build0001");

    await writeFile(path.join(dir2, "index.html"), shellFor("build0002"));
    assert.match(await (await app.request("/")).text(), /build0002/);
    assert.equal((await app.request("/api/health")).headers.get("x-bento-build"), "build0002");
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

test("emitted assets cache forever and a missing file is a 404, not the shell", async () => {
  const chunk = await stamped.request("/assets/index-abc123.js");
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=31536000, immutable");

  for (const gone of ["/assets/index-oldhash.js", "/fonts/missing.woff2", "/site.webmanifest"]) {
    const res = await stamped.request(gone);
    assert.equal(res.status, 404, gone);
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/html/, gone);
  }
});

test("root files keep their short cache", async () => {
  const icon = await stamped.request("/favicon.svg");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("cache-control"), "public, max-age=3600");
});
