import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxDriver } from "@bento/sandbox";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { loadEnv } from "./env.js";
import { singleDriver } from "./orchestrator/sandbox-driver.js";

function appWithDb(db: { execute: (query: unknown) => Promise<unknown> }) {
  return createApp({
    env: loadEnv({ BENTO_MODE: "local" } as NodeJS.ProcessEnv),
    db,
    drivers: singleDriver({ provider: "local-process", workspace: "host" } as SandboxDriver),
  } as unknown as AppContext);
}

test("/api/health answers from process state and does not touch the database", async () => {
  let pinged = false;
  const app = appWithDb({
    execute: async () => {
      pinged = true;
      throw new Error("the database must stay asleep");
    },
  });
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.equal(pinged, false);
  const body = (await res.json()) as { ok: boolean; mode: string; driver: string };
  assert.equal(body.ok, true);
  assert.equal(body.mode, "local");
  assert.equal(body.driver, "local-process");
});

test("/api/health?deep=1 pings the database", async () => {
  let pinged = false;
  const app = appWithDb({
    execute: async () => {
      pinged = true;
    },
  });
  const res = await app.request("/api/health?deep=1");
  assert.equal(res.status, 200);
  assert.equal(pinged, true);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("/api/health?deep=1 is 503 when the database is down", async () => {
  const app = appWithDb({
    execute: async () => {
      throw new Error("db down");
    },
  });
  const res = await app.request("/api/health?deep=1");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /db down/);
});
