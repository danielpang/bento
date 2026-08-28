import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { HSTS_VALUE, arrivedOverHttps, securityHeaders } from "./security-headers.js";

test("the proxy's word decides, and the client's hop is the first one", () => {
  assert.equal(arrivedOverHttps("https", "http://app.usebento.ai/"), true);
  assert.equal(arrivedOverHttps("http", "https://app.usebento.ai/"), false);
  // Two proxies deep: the browser's own hop is the entry on the left.
  assert.equal(arrivedOverHttps("https, http", "http://app.usebento.ai/"), true);
  assert.equal(arrivedOverHttps("HTTPS", "http://app.usebento.ai/"), true);
});

test("with no proxy in front, the request URL is the only witness", () => {
  assert.equal(arrivedOverHttps(undefined, "https://app.usebento.ai/board"), true);
  assert.equal(arrivedOverHttps(undefined, "http://localhost:4400/board"), false);
  assert.equal(arrivedOverHttps(undefined, "not a url"), false);
});

test("a request that arrived over TLS is answered with HSTS", async () => {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/", (c) => c.text("ok"));

  const res = await app.request("http://app.usebento.ai/", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(res.headers.get("strict-transport-security"), HSTS_VALUE);
});

/**
 * The case that matters: local mode binds 127.0.0.1 over http, and a
 * developer who puts a TLS proxy in front of it should not have two
 * years of HTTPS pinned onto localhost and everything under it.
 */
test("a plaintext request is answered without it", async () => {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/", (c) => c.text("ok"));

  const res = await app.request("http://localhost:4400/");
  assert.equal(res.headers.get("strict-transport-security"), null);
});

test("the header survives a response the route built itself", async () => {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/api/health", (c) => c.json({ ok: true }));

  const res = await app.request("http://app.usebento.ai/api/health", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(res.headers.get("strict-transport-security"), HSTS_VALUE);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a year is the floor the preload list checks, and this clears it", () => {
  const maxAge = Number(/max-age=(\d+)/.exec(HSTS_VALUE)?.[1]);
  assert.ok(maxAge >= 31536000, `max-age of ${maxAge} is below the preload minimum`);
  assert.match(HSTS_VALUE, /includeSubDomains/);
  assert.match(HSTS_VALUE, /preload/);
});
