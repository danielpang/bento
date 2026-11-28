import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readConfig } from "./config.js";

test("defaults to the local process driver, ~/.bento and a free port", () => {
  const config = readConfig({}, "/nowhere/bin");
  assert.equal(config.sandbox, "local-process");
  assert.equal(config.dataDir, path.join(os.homedir(), ".bento"));
  assert.equal(config.port, 0);
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.postgresDir, undefined);
});

test("a bundled build finds the Postgres binaries beside it", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sidecar-config-"));
  try {
    fs.mkdirSync(path.join(dist, "bin"));
    fs.mkdirSync(path.join(dist, "postgres"));
    const config = readConfig({ BENTO_DATA_DIR: "~/elsewhere", BENTO_MODEL_PROXY: "false" }, path.join(dist, "bin"));
    assert.equal(config.postgresDir, path.join(dist, "postgres"));
    assert.equal(config.dataDir, path.join(os.homedir(), "elsewhere"));
    assert.equal(config.modelProxy, false);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test("refuses settings it cannot honor rather than guessing", () => {
  assert.throws(() => readConfig({ BENTO_SANDBOX_DRIVER: "sprite" }, "/x"), /local-process/);
  assert.throws(() => readConfig({ BENTO_SIDECAR_PORT: "http" }, "/x"), /port number/);
  assert.throws(() => readConfig({ BENTO_BETA_FEATURES: "yes" }, "/x"), /"true" or "false"/);
});
