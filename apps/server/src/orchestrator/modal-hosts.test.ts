import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeAdapter, cursorAdapter, piAdapter } from "@bento/agents";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { MODEL_PROVIDERS, modelProviderForSegment } from "@bento/core";
import { modalRunHosts } from "./modal-hosts.js";
import { grantedModelCredentials, planModelProxy, proxiedAgentEnv, unreachableBaseUrlNote } from "./model-proxy-env.js";
import { singleDriver } from "./sandbox-driver.js";

test("a proxied key needs neither its provider's host nor its saved base URL", () => {
  const env = {
    ANTHROPIC_API_KEY: "secret-value",
    ANTHROPIC_BASE_URL: "https://gateway.example/v1",
    OPENAI_API_KEY: "other-secret",
  };
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: ["https://github.com/acme/app.git"],
    env,
    proxiedKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  });
  assert.deepEqual(hosts, ["https://bento.example", "https://github.com/acme/app.git"]);
});

test("only the keys the proxy carries leave the allowlist", () => {
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: [],
    env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", CURSOR_API_KEY: "c" },
    proxiedKeys: ["ANTHROPIC_API_KEY"],
  });
  assert.ok(!hosts.includes("https://api.anthropic.com"));
  assert.ok(hosts.includes("https://api.openai.com"), "a key the sandbox still holds keeps its host");
  assert.ok(hosts.includes("https://api2.cursor.sh"));
});

test("a site the team allowed stays on the list even when the proxy carries its provider's key", () => {
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: [],
    env: { OPENAI_API_KEY: "secret" },
    proxiedKeys: ["OPENAI_API_KEY"],
    extraHosts: ["api.openai.com", "*.openai.com"],
  });
  assert.deepEqual(hosts, ["https://bento.example", "api.openai.com", "*.openai.com"]);
});

test("a base URL a login token still uses stays on the list", () => {
  const hosts = modalRunHosts({
    gatewayUrl: "https://bento.example",
    cloneUrls: [],
    env: { CLAUDE_CODE_OAUTH_TOKEN: "login", ANTHROPIC_BASE_URL: "https://gateway.example" },
    proxiedKeys: [],
  });
  assert.ok(hosts.includes("https://gateway.example"));
});

test("every proxied provider has its own segment and an https upstream", () => {
  const proxied = MODEL_PROVIDERS.filter((provider) => provider.proxy);
  const segments = proxied.map((provider) => provider.proxy!.segment);
  assert.equal(new Set(segments).size, segments.length);
  for (const provider of proxied) {
    assert.match(provider.proxy!.upstream, /^https:\/\//);
    assert.equal(modelProviderForSegment(provider.proxy!.segment)?.key, provider.key);
    // The allowlist and the proxy name the same host.
    assert.ok(provider.hosts.some((host) => provider.proxy!.upstream.startsWith(host)), provider.key);
  }
  // Logins, Cursor and Ollama are not the proxy's.
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "OLLAMA_API_KEY"]) {
    assert.equal(MODEL_PROVIDERS.find((provider) => provider.key === key)?.proxy, undefined, key);
  }
});

function fakeCtx(mode: "local" | "multi", base = "https://bento.example", modelProxy?: boolean): AppContext {
  return {
    env: { BENTO_MODE: mode, BETTER_AUTH_URL: base, BENTO_MODEL_PROXY: modelProxy },
    drivers: singleDriver({ provider: "modal", workspace: "clone" } as SandboxDriver),
  } as unknown as AppContext;
}

test("the plan proxies the keys an adapter can send through it, in local mode unless turned off", async () => {
  const modal = { provider: "modal", workspace: "clone" } as SandboxDriver;
  const env = { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "" };
  const proxied = { keys: ["ANTHROPIC_API_KEY"], gatewayBase: "https://bento.example", unreachableBaseUrls: [] };
  const none = { keys: [], gatewayBase: null, unreachableBaseUrls: [] };
  assert.deepEqual(await planModelProxy(fakeCtx("multi"), claudeCodeAdapter, modal, env), proxied);
  assert.deepEqual(await planModelProxy(fakeCtx("multi", undefined, false), claudeCodeAdapter, modal, env), proxied, "multi mode cannot turn it off");
  assert.deepEqual(await planModelProxy(fakeCtx("local"), claudeCodeAdapter, modal, env), proxied, "on by default in local mode");
  assert.deepEqual(await planModelProxy(fakeCtx("local", undefined, false), claudeCodeAdapter, modal, env), none);
  const host = { provider: "local-process", workspace: "host" } as SandboxDriver;
  assert.deepEqual(await planModelProxy(fakeCtx("local", undefined, true), claudeCodeAdapter, host, env), none, "a local process is never proxied in local mode");
  assert.deepEqual((await planModelProxy(fakeCtx("multi"), cursorAdapter, modal, { CURSOR_API_KEY: "c" })).keys, []);
  assert.deepEqual((await planModelProxy(fakeCtx("multi"), claudeCodeAdapter, modal, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).keys, []);
  const local = { provider: "local-process", workspace: "host" } as SandboxDriver;
  assert.deepEqual((await planModelProxy(fakeCtx("multi"), piAdapter, local, env)).keys, [], "pi's home file is not written on the local driver");
  assert.equal((await planModelProxy(fakeCtx("multi", "http://localhost:4400"), claudeCodeAdapter, modal, env)).gatewayBase, null);
});

test("a key whose saved base URL the proxy could never fetch stays in the sandbox, with its base URL", async () => {
  const modal = { provider: "modal", workspace: "clone" } as SandboxDriver;
  for (const saved of ["http://203.0.113.9/v1", "https://10.0.0.5", "https://127.0.0.1:8443", "https://bento.example/anthropic"]) {
    const env = { ANTHROPIC_API_KEY: "sk", ANTHROPIC_BASE_URL: saved };
    const plan = await planModelProxy(fakeCtx("multi"), claudeCodeAdapter, modal, env);
    assert.deepEqual(plan, {
      keys: [],
      gatewayBase: null,
      unreachableBaseUrls: [{ key: "ANTHROPIC_API_KEY", baseUrlKey: "ANTHROPIC_BASE_URL" }],
    }, saved);
    // Not proxied, so the sandbox must reach the saved base URL itself.
    const hosts = modalRunHosts({ gatewayUrl: "https://bento.example", cloneUrls: [], env, proxiedKeys: plan.keys });
    assert.ok(hosts.includes(saved), saved);
  }
  // A public https address is proxied as before; an IP literal needs no lookup.
  const fine = await planModelProxy(fakeCtx("multi"), claudeCodeAdapter, modal, {
    ANTHROPIC_API_KEY: "sk",
    ANTHROPIC_BASE_URL: "https://1.1.1.1/anthropic",
  });
  assert.deepEqual(fine.keys, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(fine.unreachableBaseUrls, []);
  // Only the key behind the refused base URL stays out; the rest are proxied.
  const mixed = await planModelProxy(fakeCtx("multi"), piAdapter, modal, {
    ANTHROPIC_API_KEY: "sk",
    ANTHROPIC_BASE_URL: "http://gateway.internal",
    OPENAI_API_KEY: "sk-o",
  });
  assert.deepEqual(mixed.keys, ["OPENAI_API_KEY"]);
  assert.equal(
    unreachableBaseUrlNote(mixed.unreachableBaseUrls[0]!),
    "ANTHROPIC_BASE_URL is not a public https address that Bento's model proxy can reach, so this run's ANTHROPIC_API_KEY is in its sandbox rather than behind the proxy.",
  );
});

test("the sandbox's environment holds the token and the proxy's addresses, and the grant names what the proxy may read", () => {
  const env = { ANTHROPIC_API_KEY: "sk-real", ANTHROPIC_BASE_URL: "https://gateway.example", OPENROUTER_API_KEY: "sk-or", GIT_X: "kept" };
  const out = proxiedAgentEnv(env, ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"], "https://bento.example/", "bmg_t");
  assert.deepEqual(out, {
    ANTHROPIC_API_KEY: "bmg_t",
    ANTHROPIC_BASE_URL: "https://bento.example/api/model-proxy/anthropic",
    OPENROUTER_API_KEY: "bmg_t",
    OPENROUTER_BASE_URL: "https://bento.example/api/model-proxy/openrouter",
    GIT_X: "kept",
  });
  assert.deepEqual(grantedModelCredentials(env, ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENROUTER_API_KEY",
  ]);
});
