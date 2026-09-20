import assert from "node:assert/strict";
import test from "node:test";
import { assetPath, canProxyApi, isTrustedConsoleUrl, normalizeServerUrl, safeExternalUrl, validateSettings } from "./security.js";

test("connections reject embedded credentials, insecure remote hosts, and path confusion", () => {
  assert.equal(normalizeServerUrl("https://bento.example/"), "https://bento.example");
  assert.equal(normalizeServerUrl("http://127.0.0.1:4400"), "http://127.0.0.1:4400");
  for (const url of ["file:///etc/passwd", "http://bento.example", "https://user:secret@bento.example", "https://bento.example/api", "https://bento.example?next=other"]) {
    assert.throws(() => normalizeServerUrl(url));
  }
});

test("only the trusted application can borrow a session for an API request", () => {
  const origin = "https://bento.example";
  assert.ok(canProxyApi(origin, origin));
  for (const initiator of [undefined, "null", "", "https://bento.example.attacker.test", "https://attacker.test"]) {
    assert.equal(canProxyApi(initiator, origin), false);
  }
});

test("API pages and artifact downloads never acquire a privileged console bridge", () => {
  const origin = "https://bento.example";
  assert.ok(isTrustedConsoleUrl(`${origin}/session/00000000-0000-0000-0000-000000000000`, origin));
  assert.ok(isTrustedConsoleUrl(`${origin}/settings`, origin));
  for (const url of [`${origin}/api/artifacts/secret/content`, `${origin}/assets/payload.html`, `${origin}.evil.test/`, "file:///tmp/payload.html", "about:srcdoc"]) {
    assert.equal(isTrustedConsoleUrl(url, origin), false);
  }
});

test("bundled assets cannot escape their root and external links cannot execute a local handler", () => {
  assert.equal(assetPath("/bundle", "/assets/app.js"), "/bundle/assets/app.js");
  for (const url of ["/../secret", "/%2e%2e/secret", "/%00secret", "/..%5csecret", "/%ZZ"]) assert.equal(assetPath("/bundle", url), null);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/etc/passwd", "https://user:password@host.test"]) assert.equal(safeExternalUrl(url), null);
});

test("settings reject unrequested runner mode and relative local directories", () => {
  const settings = { mode: "local", serverUrl: "", dataDir: "/tmp/bento", databaseUrl: "", sandbox: "docker", sandboxImage: "bento-sandbox:dev" };
  assert.deepEqual(validateSettings(settings), settings);
  assert.throws(() => validateSettings({ ...settings, mode: "runner" }));
  assert.throws(() => validateSettings({ ...settings, dataDir: "relative" }));
  assert.throws(() => validateSettings({ ...settings, sandboxImage: "name; touch /tmp/bad" }));
});
