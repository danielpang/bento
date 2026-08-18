import { test } from "node:test";
import assert from "node:assert/strict";
import { startLogExport } from "./log-export.js";
import { loadEnv } from "./env.js";

/** An unroutable host, so flushes fail fast and nothing ever sends. */
const FAKE_ENV = {
  POSTHOG_API_KEY: "phc_test_key_never_sent_anywhere",
  POSTHOG_HOST: "http://127.0.0.1:1",
};

test("no key means no export and an untouched console", () => {
  const before = console.log;
  assert.equal(startLogExport(loadEnv({})), null);
  assert.equal(console.log, before);
});

test("stop restores the exact console functions, aliasing included", async () => {
  const originals = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const logExport = startLogExport(loadEnv(FAKE_ENV));
  assert.ok(logExport);
  assert.notEqual(console.log, originals.log, "console must be wrapped while the export is live");
  await logExport.stop();
  // Identity, not equivalence: a bound copy would break anything that
  // compares console methods, including Node's own aliasing.
  assert.equal(console.debug, originals.debug);
  assert.equal(console.log, originals.log);
  assert.equal(console.info, originals.info);
  assert.equal(console.warn, originals.warn);
  assert.equal(console.error, originals.error);
});

test("a second start while one is live is refused, not stacked", async () => {
  const logExport = startLogExport(loadEnv(FAKE_ENV));
  assert.ok(logExport);
  // Nested wrappers cannot be restored in any order without one export
  // clobbering the other, so the second caller gets nothing.
  assert.equal(startLogExport(loadEnv(FAKE_ENV)), null);
  await logExport.stop();
  // Once stopped, a fresh export may start again.
  const again = startLogExport(loadEnv(FAKE_ENV));
  assert.ok(again);
  await again.stop();
});

test("stop leaves a wrapper installed on top of ours alone", async () => {
  const original = console.warn;
  const logExport = startLogExport(loadEnv(FAKE_ENV));
  assert.ok(logExport);
  // Someone else patches console after us, the way another library or
  // a test harness would.
  const foreign = (...args: unknown[]) => {
    void args;
  };
  console.warn = foreign;
  await logExport.stop();
  assert.equal(console.warn, foreign, "stop must not tear off somebody else's wrapper");
  console.warn = original;
});

test("stop returns promptly when the OTLP endpoint is unreachable", async () => {
  const logExport = startLogExport(loadEnv(FAKE_ENV));
  assert.ok(logExport);
  console.info("one buffered record");
  const began = Date.now();
  await logExport.stop();
  assert.ok(Date.now() - began < 8000, "stop must stay inside the process's shutdown deadline");
});
