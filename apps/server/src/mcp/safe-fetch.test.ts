import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isPublicAddress, safeFetch, SafeFetchRefused, type SafeFetchPolicy } from "./safe-fetch.js";

const multi: SafeFetchPolicy = { mode: "multi", ownHosts: ["bento.example.test"] };
const local: SafeFetchPolicy = { mode: "local", ownHosts: [] };

test("only globally routable addresses count as public", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "198.18.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} must not count as public`);
  }
  const allowed = ["1.1.1.1", "8.8.8.8", "140.82.112.3", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of allowed) {
    assert.equal(isPublicAddress(ip), true, `${ip} must count as public`);
  }
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("an IPv4-mapped IPv6 in hex form is judged by the embedded IPv4", () => {
  // The URL parser normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe,
  // so the guard must reach the embedded IPv4 in the hex form too, or the
  // cloud-metadata and loopback addresses slip through.
  for (const ip of [
    "::ffff:a9fe:a9fe", // 169.254.169.254 metadata
    "::ffff:7f00:1", // 127.0.0.1 loopback
    "::ffff:0a00:1", // 10.0.0.1 private
    "::ffff:c0a8:1", // 192.168.0.1 private
    "64:ff9b::a9fe:a9fe", // NAT64 to 169.254.169.254
  ]) {
    assert.equal(isPublicAddress(ip), false, `${ip} must not count as public`);
  }
  assert.equal(isPublicAddress("::ffff:0808:0808"), true, "::ffff:8.8.8.8 stays public");
});

test("multi mode refuses an IPv4-mapped metadata address in hex form", async () => {
  await assert.rejects(safeFetch("https://[::ffff:a9fe:a9fe]/mcp", {}, multi), SafeFetchRefused);
  await assert.rejects(safeFetch("https://[::ffff:7f00:1]/mcp", {}, multi), SafeFetchRefused);
});

test("multi mode refuses plain http", async () => {
  await assert.rejects(safeFetch("http://mcp.example.com/mcp", {}, multi), SafeFetchRefused);
});

test("multi mode refuses schemes that are not http(s)", async () => {
  await assert.rejects(safeFetch("file:///etc/passwd", {}, multi), SafeFetchRefused);
  await assert.rejects(safeFetch("gopher://x/", {}, multi), SafeFetchRefused);
  await assert.rejects(safeFetch("not a url", {}, multi), SafeFetchRefused);
});

test("multi mode refuses private and metadata addresses by IP", async () => {
  for (const url of [
    "https://127.0.0.1/mcp",
    "https://10.1.2.3/mcp",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/mcp",
    "https://[fd00::1]/mcp",
  ]) {
    await assert.rejects(safeFetch(url, {}, multi), SafeFetchRefused, `${url} must be refused`);
  }
});

test("multi mode refuses hostnames that resolve privately", async () => {
  // localhost resolves to loopback everywhere; the refusal must come
  // from the resolved address, not from string-matching the name.
  await assert.rejects(safeFetch("https://localhost/mcp", {}, multi), SafeFetchRefused);
});

test("multi mode never fetches our own host", async () => {
  await assert.rejects(
    safeFetch("https://bento.example.test/api/anything", {}, multi),
    /point at Bento itself/,
  );
});

test("local mode fetches loopback http, and redirects are refused everywhere", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await safeFetch(`${base}/ok`, {}, local);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    // A redirect would escape whatever was validated, so even the
    // trusted local mode refuses to follow one.
    await assert.rejects(safeFetch(`${base}/redirect`, {}, local), /redirect/);
  } finally {
    server.close();
  }
});
