import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { clearCatalogCache, displayTitle, fetchCatalog, slugFor, toEntries } from "./catalog.js";

const localPolicy = { mode: "local" as const, ownHosts: [] };

test("only servers with a reachable remote are offered", () => {
  const entries = toEntries([
    {
      server: {
        name: "com.notion/mcp",
        title: "Notion",
        description: "Notion workspace",
        remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
      },
    },
    // stdio only: Bento cannot reach a command, so it must not be listed.
    { server: { name: "io.github.someone/local-fs", title: "Filesystem" } },
    // A remote with a transport Bento does not speak.
    { server: { name: "com.other/ws", title: "WS", remotes: [{ type: "websocket", url: "wss://x/y" }] } },
  ]);
  assert.deepEqual(entries.map((e) => e.name), ["com.notion/mcp"]);
  assert.equal(entries[0]!.transport, "http");
  assert.equal(entries[0]!.url, "https://mcp.notion.com/mcp");
});

test("streamable HTTP wins when a server publishes both transports", () => {
  const [entry] = toEntries([
    {
      server: {
        name: "com.dual/mcp",
        remotes: [
          { type: "sse", url: "https://dual.test/sse" },
          { type: "streamable-http", url: "https://dual.test/mcp" },
        ],
      },
    },
  ]);
  assert.equal(entry!.transport, "http");
  assert.equal(entry!.url, "https://dual.test/mcp");
});

test("an sse-only server is still offered, as sse", () => {
  const [entry] = toEntries([
    { server: { name: "com.old/mcp", remotes: [{ type: "sse", url: "https://old.test/sse" }] } },
  ]);
  assert.equal(entry!.transport, "sse");
});

test("one row per server name, so versions do not repeat the entry", () => {
  const rows = [
    { server: { name: "a.b/c", title: "v1", remotes: [{ type: "streamable-http", url: "https://a.test/1" }] } },
    { server: { name: "a.b/c", title: "v2", remotes: [{ type: "streamable-http", url: "https://a.test/2" }] } },
  ];
  assert.equal(toEntries(rows).length, 1);
});

test("the publisher is the namespace, with github noise trimmed", () => {
  const entries = toEntries([
    { server: { name: "com.notion/mcp", remotes: [{ type: "streamable-http", url: "https://n.test/mcp" }] } },
    { server: { name: "io.github.alice/thing", remotes: [{ type: "streamable-http", url: "https://a.test/mcp" }] } },
  ]);
  assert.equal(entries[0]!.publisher, "com.notion");
  assert.equal(entries[1]!.publisher, "alice");
});

test("a slug names the vendor, not the generic tail everyone publishes", () => {
  // The common shape is "<vendor>/mcp"; the tail alone would make every
  // one of these collide on "mcp".
  assert.equal(slugFor({ name: "com.notion/mcp" }), "notion");
  assert.equal(slugFor({ name: "com.linear/mcp" }), "linear");
  assert.equal(slugFor({ name: "com.sentry/mcp" }), "sentry");
  // A meaningful tail is kept.
  assert.equal(slugFor({ name: "io.github.upstash/context7" }), "context7");
  assert.equal(slugFor({ name: "ai.smithery/smithery-notion" }), "smithery-notion");
  // The vendor namespace is preferred over the title, so the slug stays
  // stable even if a publisher renames their listing.
  assert.equal(slugFor({ name: "acme.docs/mcp", title: "Renamed Later" }), "docs");
  // A name with nothing usable in the tail still yields something.
  assert.equal(slugFor({ name: "weird/!!!" }), "weird");
  assert.equal(slugFor({ name: "mcp/mcp", title: "Acme Docs" }), "acme-docs");
});

// A fixture registry, so the suite never depends on a live third party.
let registry: Server;
let registryUrl: string;
let lastQuery = "";

before(async () => {
  registry = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastQuery = url.search;
    if (url.pathname !== "/v0/servers") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        servers: [
          {
            server: {
              name: "com.notion/mcp",
              title: "Notion",
              description: "Notion workspace",
              remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
            },
          },
          { server: { name: "io.github.x/stdio-only", title: "Local" } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
});

after(() => registry?.close());

test("the catalog reads the registry and asks for current versions only", async () => {
  clearCatalogCache();
  const { entries, reachable } = await fetchCatalog(localPolicy, { registryUrl, search: "notion" });
  assert.equal(reachable, true);
  assert.deepEqual(entries.map((e) => e.title), ["Notion"]);
  assert.match(lastQuery, /version=latest/);
  assert.match(lastQuery, /search=notion/);
});

test("a second read is served from cache", async () => {
  clearCatalogCache();
  await fetchCatalog(localPolicy, { registryUrl, search: "cached" });
  lastQuery = "";
  await fetchCatalog(localPolicy, { registryUrl, search: "cached" });
  assert.equal(lastQuery, "", "the registry must not be hit twice inside the cache window");
});

test("an unreachable registry answers empty rather than throwing", async () => {
  clearCatalogCache();
  const { entries, reachable } = await fetchCatalog(localPolicy, {
    registryUrl: "http://127.0.0.1:1/nope",
  });
  assert.equal(reachable, false);
  assert.deepEqual(entries, []);
});

test("a missing title becomes the vendor, not the raw registry name", () => {
  // Most registry entries carry no title, and "com.notion/mcp" is not
  // something to put in a list a person reads.
  assert.equal(displayTitle("com.notion/mcp"), "Notion");
  assert.equal(displayTitle("io.github.upstash/context7"), "Context7");
  assert.equal(displayTitle("ai.smithery/smithery-notion"), "Smithery Notion");
  // A title the publisher did set is left alone.
  assert.equal(displayTitle("com.notion/mcp", "Notion Official"), "Notion Official");
});

test("an entry carries the host its icon comes from", () => {
  const [entry] = toEntries([
    {
      server: {
        name: "com.notion/mcp",
        remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
      },
    },
  ]);
  assert.equal(entry!.iconHost, "mcp.notion.com");
});

test("a generic namespace tail does not become the title", () => {
  // com.cloudflare.mcp/mcp and com.paypal.mcp/mcp both came out as
  // "Mcp": the tail was generic, and so was the last namespace label.
  assert.equal(displayTitle("com.cloudflare.mcp/mcp"), "Cloudflare");
  assert.equal(displayTitle("com.paypal.mcp/mcp"), "Paypal");
  assert.equal(displayTitle("com.notion/mcp"), "Notion");
});

test("a domain suffix in the tail is address, not name", () => {
  assert.equal(displayTitle("com.monday/monday.com"), "Monday");
});

test("a title the registry gives always wins", () => {
  assert.equal(displayTitle("com.cloudflare.mcp/mcp", "Cloudflare Docs"), "Cloudflare Docs");
});

test("a generic suffix in the tail is trimmed", () => {
  assert.equal(displayTitle("com.vercel/vercel-mcp"), "Vercel");
  assert.equal(displayTitle("com.close/close-mcp"), "Close");
  // Not over-trimmed: a name that is only the generic word keeps it.
  assert.equal(displayTitle("com.example/mcp"), "Example");
});
