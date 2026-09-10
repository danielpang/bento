import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppContext } from "../context.js";
import {
  applyInitialAgentAuthSharing,
  readSettings,
  shouldShareAgentAuth,
  writeSettings,
} from "../settings.js";
import { settingsRoutes } from "./settings.js";

test("machine settings report effective login sharing, including launch overrides", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-sharing-route-"));
  try {
    for (const stored of [false, true]) {
      for (const override of [undefined, false, true]) {
        const ctx = {
          env: {
            BENTO_MODE: "local",
            BENTO_DATA_DIR: dataDir,
            BENTO_SHARE_AGENT_AUTH: override,
          },
        } as AppContext;
        await writeSettings(ctx, { shareAgentAuth: stored });
        const routes = settingsRoutes(ctx);
        const response = await routes.request("/");
        assert.equal(response.status, 200);
        const settings = await response.json();
        assert.equal(settings.shareAgentAuth, override ?? stored);
        assert.equal(settings.pinnedByEnv, override !== undefined);

        const updated = await routes.request("/", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shareAgentAuth: !stored }),
        });
        assert.equal(updated.status, 200);
        assert.equal((await updated.json()).shareAgentAuth, override ?? !stored);
        assert.equal((await readSettings(ctx)).shareAgentAuth, !stored);
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CLI sharing enables the next run and settings can disable it across a restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-sharing-cli-"));
  const ctx = {
    env: { BENTO_MODE: "local", BENTO_DATA_DIR: dataDir, BENTO_SHARE_AGENT_AUTH: false },
  } as AppContext;
  try {
    const original = {
      shareAgentAuth: false,
      gitAuthorName: "Test Author",
      gitAuthorEmail: "test@example.com",
      includeStageNotesInPr: true,
    };
    await writeSettings(ctx, original);
    await applyInitialAgentAuthSharing(ctx, undefined);
    assert.equal(
      ctx.env.BENTO_SHARE_AGENT_AUTH,
      false,
      "omitting the flag preserves an explicit environment",
    );
    await applyInitialAgentAuthSharing(ctx, true);
    assert.equal(await shouldShareAgentAuth(ctx), true);
    assert.deepEqual(await readSettings(ctx), { ...original, shareAgentAuth: true });
    const routes = settingsRoutes(ctx);
    const settings = await (await routes.request("/")).json();
    assert.equal(settings.shareAgentAuth, true);
    assert.equal(settings.pinnedByEnv, false);
    const updated = await routes.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareAgentAuth: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).shareAgentAuth, false);
    assert.equal(await shouldShareAgentAuth(ctx), false, "the next run honors the settings edit");
    const restarted = { env: { BENTO_MODE: "local", BENTO_DATA_DIR: dataDir } } as AppContext;
    await applyInitialAgentAuthSharing(restarted, undefined);
    assert.equal(await shouldShareAgentAuth(restarted), false);
    assert.deepEqual(await readSettings(restarted), original, "unrelated settings survive");
    await applyInitialAgentAuthSharing(restarted, true);
    assert.equal(await shouldShareAgentAuth(restarted), true, "passing the flag again enables sharing again");
    const multi = { env: { ...restarted.env, BENTO_MODE: "multi" } } as AppContext;
    await applyInitialAgentAuthSharing(multi, false);
    assert.equal(await shouldShareAgentAuth(multi), false);
    assert.equal(
      (await readSettings(restarted)).shareAgentAuth,
      true,
      "multi mode must not change machine settings",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
