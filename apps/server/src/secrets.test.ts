import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { SecretBox, SecretUnreadable, isLegacySecret, maskSecret, type SecretSlot } from "./secrets.js";

const ORG_A: SecretSlot = { kind: "org_secret", organizationId: "org-a", name: "ANTHROPIC_API_KEY" };

/** What the server wrote before values were sealed to their slot. */
function legacyEncrypt(secret: string, plaintext: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

test("a secret round trips in its slot and its ciphertext never contains the value", () => {
  const box = new SecretBox("a".repeat(32));
  const plaintext = "sk-ant-super-secret-value";
  const stored = box.encrypt(plaintext, ORG_A);

  assert.doesNotMatch(stored, /super-secret/, "ciphertext must not leak the value");
  assert.match(stored, /^v2:k0:[^:]+:[^:]+:[^:]*$/, "the versioned format names its key");
  assert.equal(box.decrypt(stored, ORG_A), plaintext);
});

test("the same value encrypts differently each time", () => {
  const box = new SecretBox("a".repeat(32));
  // A fresh IV per encryption, so equal keys are not detectable by
  // comparing stored ciphertexts.
  assert.notEqual(box.encrypt("same", ORG_A), box.encrypt("same", ORG_A));
});

test("a value copied to another organization, name, row or member fails to decrypt", () => {
  const box = new SecretBox("a".repeat(32));
  const stored = box.encrypt("sk-ant-org-a", ORG_A);
  const elsewhere: SecretSlot[] = [
    { ...ORG_A, organizationId: "org-b" },
    { ...ORG_A, organizationId: null },
    { ...ORG_A, name: "OPENAI_API_KEY" },
    { kind: "custom_provider_key", organizationId: "org-a", providerId: "ANTHROPIC_API_KEY" },
  ];
  for (const slot of elsewhere) {
    assert.throws(() => box.decrypt(stored, slot), SecretUnreadable, JSON.stringify(slot));
  }

  const access: SecretSlot = { kind: "mcp_credential", organizationId: "org-a", serverId: "s1", userId: "u1", part: "access" };
  const token = box.encrypt("oauth-access", access);
  assert.equal(box.decrypt(token, access), "oauth-access");
  assert.throws(() => box.decrypt(token, { ...access, userId: "u2" }), SecretUnreadable, "another member");
  assert.throws(() => box.decrypt(token, { ...access, userId: null }), SecretUnreadable, "the team's row");
  assert.throws(() => box.decrypt(token, { ...access, serverId: "s2" }), SecretUnreadable, "another server");
  assert.throws(() => box.decrypt(token, { ...access, part: "refresh" }), SecretUnreadable, "the other column");
});

test("a null organization and a string one never encode alike", () => {
  const box = new SecretBox("a".repeat(32));
  const local = box.encrypt("v", { kind: "slack_bot_token", organizationId: null });
  assert.throws(() => box.decrypt(local, { kind: "slack_bot_token", organizationId: "null" }), SecretUnreadable);
  assert.throws(() => box.decrypt(local, { kind: "slack_bot_token", organizationId: "" }), SecretUnreadable);
});

test("a tampered secret fails to decrypt rather than returning garbage", () => {
  const box = new SecretBox("a".repeat(32));
  const [version, keyId, iv, tag, data] = box.encrypt("original", ORG_A).split(":");
  const flipped = Buffer.from(data!, "base64");
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => box.decrypt([version, keyId, iv, tag, flipped.toString("base64")].join(":"), ORG_A), SecretUnreadable);
  // The key id is authenticated too, so it cannot be rewritten to pass.
  assert.throws(() => box.decrypt([version, "k1", iv, tag, data].join(":"), ORG_A), SecretUnreadable);
  assert.throws(() => box.decrypt(`${version}:${keyId}:${iv}:${tag}`, ORG_A), SecretUnreadable, "truncated");
});

test("a different key cannot read another key's secrets", () => {
  const stored = new SecretBox("a".repeat(32)).encrypt("value", ORG_A);
  assert.throws(() => new SecretBox("b".repeat(32)).decrypt(stored, ORG_A), SecretUnreadable);
});

test("a legacy value is never read directly, only upgraded into the slot it is found in", () => {
  const box = new SecretBox("a".repeat(32));
  const legacy = legacyEncrypt("a".repeat(32), "sk-ant-legacy");
  assert.equal(isLegacySecret(legacy), true);
  // An attacker who can write rows could otherwise plant an unbound value.
  assert.throws(() => box.decrypt(legacy, ORG_A), /legacy/);

  const upgraded = box.upgradeLegacy(legacy, ORG_A);
  assert.equal(isLegacySecret(upgraded), false);
  assert.equal(box.decrypt(upgraded, ORG_A), "sk-ant-legacy");
  assert.throws(() => box.decrypt(upgraded, { ...ORG_A, organizationId: "org-b" }), SecretUnreadable);

  // A legacy value under another key stays unreadable; nothing is invented.
  assert.throws(() => box.upgradeLegacy(legacyEncrypt("b".repeat(32), "x"), ORG_A), SecretUnreadable);
  // And a current value is not "upgraded" again into a new slot.
  assert.throws(() => box.upgradeLegacy(upgraded, { ...ORG_A, organizationId: "org-b" }), SecretUnreadable);
});

test("a short encryption key is refused rather than silently weakening", () => {
  assert.throws(() => new SecretBox("too-short"), /at least 32/);
});

test("the mask reveals only a short tail", () => {
  assert.equal(maskSecret("sk-ant-abcdefghijkl"), "••••••••ijkl");
  // Nothing at all for values too short to hide a tail in.
  assert.equal(maskSecret("abc"), "••••••••");
});

test("local mode derives a usable key from any data directory", async () => {
  // Regression: concatenating a short data directory produced a key
  // under the minimum length, so `bento` refused to start at all.
  const { createHash } = await import("node:crypto");
  for (const dataDir of ["/a", "~/.bento", "/very/long/path/to/a/data/directory/somewhere"]) {
    const derived = createHash("sha256").update(`bento-local:${dataDir}`).digest("hex");
    const box = new SecretBox(derived);
    assert.equal(box.decrypt(box.encrypt("value", ORG_A), ORG_A), "value");
  }
});

test("agent logins are never shared in multi mode", async () => {
  const { agentAuthMounts } = await import("./orchestrator/agent-auth.js");
  const { getAdapter } = await import("@bento/agents");
  const adapter = getAdapter("claude-code");

  // Even asked for explicitly, an operator's login must not reach a
  // tenant's sandbox: it is a paid account an agent could read.
  const multi = { env: { BENTO_MODE: "multi", BENTO_SHARE_AGENT_AUTH: true } } as never;
  assert.deepEqual(await agentAuthMounts(multi, adapter), []);

  // And off unless asked for, even locally.
  const localOff = { env: { BENTO_MODE: "local", BENTO_SHARE_AGENT_AUTH: false } } as never;
  assert.deepEqual(await agentAuthMounts(localOff, adapter), []);
});

/**
 * Sharing is a stored setting, not only a launch flag, so a setup
 * screen can turn it on and the very next run honours it. A flag that
 * needed a relaunch would look like it had worked and quietly not have.
 */
test("sharing agent logins is a stored setting the next run honours", async () => {
  const { agentAuthMounts } = await import("./orchestrator/agent-auth.js");
  const { readSettings, writeSettings, shouldShareAgentAuth } = await import("./settings.js");
  const { getAdapter } = await import("@bento/agents");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");

  const dataDir = await mkdtemp(nodePath.join(tmpdir(), "bento-settings-"));
  const adapter = getAdapter("claude-code");
  const local = { env: { BENTO_MODE: "local", BENTO_DATA_DIR: dataDir } } as never;

  try {
    // Never configured is off, and an absent file is not an error.
    assert.equal((await readSettings(local)).shareAgentAuth, false);
    assert.equal(await shouldShareAgentAuth(local), false);
    assert.deepEqual(await agentAuthMounts(local, adapter), []);

    await writeSettings(local, { shareAgentAuth: true });
    assert.equal(await shouldShareAgentAuth(local), true, "the stored setting decides with no env var");

    // An explicit environment variable still wins, so the launch flag
    // stays an override and CI stays predictable.
    const pinnedOff = { env: { ...local.env, BENTO_SHARE_AGENT_AUTH: false } } as never;
    assert.equal(await shouldShareAgentAuth(pinnedOff), false);

    // And multi mode ignores the setting however it was stored.
    const multi = { env: { ...local.env, BENTO_MODE: "multi" } } as never;
    assert.equal(await shouldShareAgentAuth(multi), false);
    assert.deepEqual(await agentAuthMounts(multi, adapter), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("git identity is not taken from the host in multi mode", async () => {
  const { gitIdentityEnv } = await import("./orchestrator/agent-auth.js");
  const multi = { env: { BENTO_MODE: "multi" } } as never;
  assert.deepEqual(await gitIdentityEnv(multi), {});
});

/**
 * `.env.example` ships optional keys with nothing after the `=`, and
 * anything that forwards an environment passes those on as empty
 * strings. Read literally, an empty key is not "no key", and local mode
 * refused to start because it saw one too short to use.
 */
test("an environment variable set to empty reads as absent", async () => {
  const { loadEnv } = await import("./env.js");
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5439/app",
    BENTO_SECRET_KEY: "",
    BETTER_AUTH_SECRET: "",
  } as NodeJS.ProcessEnv);

  assert.equal(env.BENTO_SECRET_KEY, undefined, "an empty key must not count as one");
  assert.equal(env.BETTER_AUTH_SECRET, undefined);

  // And a real value still arrives intact.
  const set = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5439/app",
    BENTO_SECRET_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv);
  assert.equal(set.BENTO_SECRET_KEY, "a".repeat(64));
});
