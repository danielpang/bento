import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cursorAdapter } from "@bento/agents";
import type { AppContext } from "../context.js";
import { agentAuthEnv, agentAuthMounts } from "./agent-auth.js";
import { cursorLoginEnv } from "./cursor-auth.js";

const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.test`;

test("Cursor uses a macOS login token without sharing its refresh token or home", async () => {
  const token = jwt(Math.floor(Date.now() / 1000) + 3600);
  const services: string[] = [];
  const env = await cursorLoginEnv({
    platform: "darwin",
    home: "/unused",
    readKeychain: async (service) => {
      services.push(service);
      return token;
    },
  });
  assert.deepEqual(env, { CURSOR_AUTH_TOKEN: token });
  assert.ok(cursorAdapter.authAlternatives?.includes("CURSOR_AUTH_TOKEN"));
  assert.deepEqual(services, ["cursor-access-token"]);
  const ctx = { env: { BENTO_MODE: "local", BENTO_SHARE_AGENT_AUTH: true } } as AppContext;
  assert.deepEqual(await agentAuthMounts(ctx, cursorAdapter), []);
});

test("Cursor reads native file logins and does not forward expired tokens", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bento-cursor-auth-"));
  const token = jwt(Math.floor(Date.now() / 1000) + 3600);
  const readKeychain = async () => null;
  try {
    for (const platform of ["linux", "win32", "darwin"] as const) {
      const directory = path.join(
        home,
        platform === "linux" ? ".config/cursor" : platform === "win32" ? "AppData/Roaming/Cursor" : ".cursor",
      );
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, "auth.json");
      const options = { platform, home, readKeychain };
      await writeFile(filename, JSON.stringify({ accessToken: token, refreshToken: "never-shared" }));
      assert.deepEqual(await cursorLoginEnv(options), { CURSOR_AUTH_TOKEN: token });
      await writeFile(filename, JSON.stringify({ accessToken: jwt(1), apiKey: "test-api-key" }));
      assert.deepEqual(await cursorLoginEnv(options), { CURSOR_API_KEY: "test-api-key" });
      await writeFile(filename, JSON.stringify({ accessToken: jwt(1), refreshToken: "never-shared" }));
      assert.deepEqual(await cursorLoginEnv(options), {});
      await writeFile(filename, "invalid json");
      assert.deepEqual(await cursorLoginEnv(options), {});
    }
    const custom = path.join(home, "custom", "cursor");
    await mkdir(custom, { recursive: true });
    await writeFile(path.join(custom, "auth.json"), JSON.stringify({ accessToken: token }));
    assert.deepEqual(
      await cursorLoginEnv({
        platform: "linux",
        home,
        xdgConfigHome: path.join(home, "custom"),
        readKeychain,
      }),
      { CURSOR_AUTH_TOKEN: token },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Cursor falls back to a macOS API key when its login token has expired", async () => {
  assert.deepEqual(
    await cursorLoginEnv({
      platform: "darwin",
      home: "/unused",
      readKeychain: async (service) => (service === "cursor-access-token" ? jwt(1) : "test-api-key"),
    }),
    { CURSOR_API_KEY: "test-api-key" },
  );
});

test("Cursor credentials are never shared in multi mode or when sharing is disabled", async () => {
  for (const env of [
    { BENTO_MODE: "multi", BENTO_SHARE_AGENT_AUTH: true },
    { BENTO_MODE: "local", BENTO_SHARE_AGENT_AUTH: false },
  ]) {
    const ctx = { env } as AppContext;
    assert.deepEqual(await agentAuthEnv(ctx, cursorAdapter), {});
    assert.deepEqual(await agentAuthMounts(ctx, cursorAdapter), []);
  }
});
