import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ALLOWED_HOSTS, parseAllowedHost, parseAllowedHosts } from "./network-allowlist.js";

test("a host, a wildcard over a domain, and a pasted URL are accepted", () => {
  assert.deepEqual(parseAllowedHost("registry.npmjs.org"), { host: "registry.npmjs.org" });
  assert.deepEqual(parseAllowedHost(" *.Example.com "), { host: "*.example.com" });
  assert.deepEqual(parseAllowedHost("https://api.example.com:8443/v1/mcp?x=1"), { host: "api.example.com" });
  assert.deepEqual(parseAllowedHost("*.co.uk."), { host: "*.co.uk" });
  assert.deepEqual(parseAllowedHost("localhost"), { host: "localhost" });
});

test("a wildcard over a top level domain, or anywhere but the front, is refused", () => {
  for (const entry of ["*", "*.com", "*.", "api.*.example.com", "*example.com", "**.example.com"]) {
    assert.ok("error" in parseAllowedHost(entry), entry);
  }
});

test("something that is not a host name is refused", () => {
  for (const entry of ["not a host", "-bad.example.com", "exa_mple.com", "a..b", "https://"]) {
    assert.ok("error" in parseAllowedHost(entry), entry);
  }
});

test("a list skips blank lines, drops duplicates, and reports every refusal", () => {
  assert.deepEqual(parseAllowedHosts(["a.example.com", "", "A.example.com", "*.example.com"]), {
    hosts: ["a.example.com", "*.example.com"],
  });
  const refused = parseAllowedHosts(["*.com", "ok.example.com", "*.net"]);
  assert.ok("errors" in refused);
  assert.equal(refused.errors.length, 2);
  const tooMany = parseAllowedHosts(Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, i) => `h${i}.example.com`));
  assert.ok("errors" in tooMany);
});
