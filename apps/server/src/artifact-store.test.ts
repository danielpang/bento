import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskArtifactStore, createArtifactStore } from "./artifact-store.js";
import { loadEnv } from "./env.js";

test("the disk store round-trips bytes and forgets removed keys", async () => {
  const store = new DiskArtifactStore(await mkdtemp(path.join(tmpdir(), "bento-artifacts-")));
  const key = "org/org-a/feature/f1/run/r1/a1";
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);

  await store.put(key, body, "image/png");
  assert.deepEqual(await store.get(key), body);

  await store.remove([key]);
  assert.equal(await store.get(key), null, "a removed key reads as absent");
  await store.remove([key]); // removing again is not an error
});

test("keys that could leave the store's directory are refused", async () => {
  const store = new DiskArtifactStore(await mkdtemp(path.join(tmpdir(), "bento-artifacts-")));
  for (const key of ["../outside", "org/../../etc/passwd", "/absolute", ""]) {
    await assert.rejects(store.get(key), /unsafe artifact key/, `key ${JSON.stringify(key)} must be refused`);
  }
});

test("boot picks the store the environment describes", () => {
  const base = { DATABASE_URL: "postgres://x/y", BENTO_DATA_DIR: "/tmp/bento-store-test" };

  // Local mode with no bucket: the data directory.
  const local = createArtifactStore(loadEnv({ ...base, BENTO_MODE: "local" } as NodeJS.ProcessEnv));
  assert.ok(local instanceof DiskArtifactStore);

  // Multi mode with no bucket: no store, said out loud at boot.
  const bare = createArtifactStore(loadEnv({ ...base, BENTO_MODE: "multi" } as NodeJS.ProcessEnv));
  assert.equal(bare, null);

  // The names `fly storage create` injects are enough on their own.
  const tigris = createArtifactStore(
    loadEnv({
      ...base,
      BENTO_MODE: "multi",
      BUCKET_NAME: "bento-artifacts",
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
      AWS_ACCESS_KEY_ID: "tid_x",
      AWS_SECRET_ACCESS_KEY: "tsec_y",
      AWS_REGION: "auto",
    } as NodeJS.ProcessEnv),
  );
  assert.ok(tigris);
  assert.match(tigris.description, /fly\.storage\.tigris\.dev\/bento-artifacts/);

  // BENTO_ARTIFACTS_* wins over the generic names when both are set.
  const named = createArtifactStore(
    loadEnv({
      ...base,
      BENTO_MODE: "multi",
      BENTO_ARTIFACTS_BUCKET: "explicit",
      BENTO_ARTIFACTS_ENDPOINT: "https://example.test",
      BENTO_ARTIFACTS_ACCESS_KEY_ID: "a",
      BENTO_ARTIFACTS_SECRET_ACCESS_KEY: "b",
      BUCKET_NAME: "generic",
      AWS_ENDPOINT_URL_S3: "https://other.test",
      AWS_ACCESS_KEY_ID: "c",
      AWS_SECRET_ACCESS_KEY: "d",
    } as NodeJS.ProcessEnv),
  );
  assert.match(named!.description, /example\.test\/explicit/);
});
