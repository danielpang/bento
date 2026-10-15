import { test } from "node:test";
import assert from "node:assert/strict";
import { drivesRuns, loadEnv, logExportTarget, parseOtlpHeaders, posthogApiKey, runSlots } from "./env.js";

test("posthogApiKey is null when the key is unset", () => {
  assert.equal(posthogApiKey(loadEnv({ BENTO_MODE: "multi" })), null);
  assert.equal(posthogApiKey(loadEnv({})), null);
});

test("posthogApiKey is null in local mode even with a leftover key", () => {
  assert.equal(
    posthogApiKey(loadEnv({ BENTO_MODE: "local", POSTHOG_API_KEY: "phc_leftover_from_hosted" })),
    null,
  );
});

test("posthogApiKey is null for whitespace-only keys", () => {
  assert.equal(posthogApiKey(loadEnv({ BENTO_MODE: "multi", POSTHOG_API_KEY: "   " })), null);
});

test("posthogApiKey returns the trimmed token in multi mode", () => {
  assert.equal(
    posthogApiKey(loadEnv({ BENTO_MODE: "multi", POSTHOG_API_KEY: "  phc_real  " })),
    "phc_real",
  );
});

test("logExportTarget is null with neither a PostHog key nor an OTLP endpoint", () => {
  assert.equal(logExportTarget(loadEnv({})), null);
  assert.equal(logExportTarget(loadEnv({ BENTO_MODE: "multi" })), null);
  assert.equal(
    logExportTarget(loadEnv({ BENTO_MODE: "local", POSTHOG_API_KEY: "phc_leftover" })),
    null,
  );
});

test("logExportTarget defaults to PostHog's OTLP endpoint with the bearer token", () => {
  const target = logExportTarget(
    loadEnv({ BENTO_MODE: "multi", POSTHOG_API_KEY: " phc_real ", POSTHOG_HOST: "https://eu.i.posthog.com/" }),
  );
  assert.deepEqual(target, {
    destination: "posthog",
    url: "https://eu.i.posthog.com/i/v1/logs",
    headers: { Authorization: "Bearer phc_real" },
  });
});

test("OTEL_EXPORTER_OTLP_ENDPOINT gets the logs path appended and wins over PostHog", () => {
  const target = logExportTarget(
    loadEnv({
      BENTO_MODE: "multi",
      POSTHOG_API_KEY: "phc_real",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=abc, x-scope-orgid=tenant%2C1",
    }),
  );
  assert.deepEqual(target, {
    destination: "otlp",
    url: "http://collector:4318/v1/logs",
    // Only the OTLP headers: the PostHog token must not leak to another vendor.
    headers: { "x-api-key": "abc", "x-scope-orgid": "tenant,1" },
  });
});

test("the logs specific endpoint is used as written, in local mode too", () => {
  const target = logExportTarget(
    loadEnv({
      BENTO_MODE: "local",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example.com/otlp/logs",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic%20abc,shared=general",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "shared=logs",
    }),
  );
  assert.deepEqual(target, {
    destination: "otlp",
    url: "https://logs.example.com/otlp/logs",
    headers: { authorization: "Basic abc", shared: "logs" },
  });
});

test("parseOtlpHeaders tolerates blanks, stray commas, and a bare percent", () => {
  assert.deepEqual(parseOtlpHeaders(undefined), {});
  assert.deepEqual(parseOtlpHeaders(" , novalue , =nokey , k = v , "), { k: "v" });
  assert.deepEqual(parseOtlpHeaders("token=100%"), { token: "100%" });
});

test("the role, not the slot count, says whether a process drives runs", () => {
  const base = { DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv;
  const all = loadEnv(base);
  assert.equal(all.BENTO_ROLE, "all");
  assert.equal(drivesRuns(all), true);
  assert.equal(runSlots(all), 4);

  const web = loadEnv({ ...base, BENTO_ROLE: "web" });
  assert.equal(drivesRuns(web), false);
  assert.equal(runSlots(web), 0);

  const worker = loadEnv({ ...base, BENTO_ROLE: "worker", BENTO_MAX_CONCURRENT_RUNS: "32" });
  assert.equal(drivesRuns(worker), true);
  assert.equal(runSlots(worker), 32);
});

test("a web process that sets a slot count is refused at boot", () => {
  assert.throws(
    () => loadEnv({ DATABASE_URL: "postgres://x", BENTO_ROLE: "web", BENTO_MAX_CONCURRENT_RUNS: "8" } as NodeJS.ProcessEnv),
    /BENTO_ROLE=web drives no agent runs/,
  );
  assert.throws(
    () => loadEnv({ DATABASE_URL: "postgres://x", BENTO_MAX_CONCURRENT_RUNS: "0" } as NodeJS.ProcessEnv),
    /BENTO_MAX_CONCURRENT_RUNS/,
  );
});
