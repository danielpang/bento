import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { MAX_SWARM_PLAN_SOURCE_CHARS } from "@bento/core";
import {
  collectPlanSources,
  fetchPlanWebsite,
  htmlToText,
  PlanSourceRefusal,
  textRefusal,
  type FetchedPage,
} from "./plan-sources.js";

/**
 * The plan a person hands over, from the two directions it arrives:
 * as text the console already read, and as an address the server has
 * to read for them.
 */

const ENV = { BENTO_MODE: "local" as const, BETTER_AUTH_URL: "http://localhost:4400" };

test("a page is reduced to what a reader sees, with its structure kept as markdown", () => {
  const page = htmlToText(`<!doctype html><html><head><title>  Totals &amp; rounding  </title>
<style>body{color:red}</style><script>alert("x")</script></head>
<body><nav><a href="/">Home</a></nav>
<main>
<h1>Totals plan</h1>
<p>Round <b>before</b> converting.&nbsp;Always.</p>
<ul><li>Add the helper</li><li>Wire it in</li></ul>
<pre><code>const x = a &lt; b;</code></pre>
<table><tr><th>Step</th><th>Owner</th></tr><tr><td>1</td><td>Sam</td></tr></table>
</main>
<footer>Copyright</footer></body></html>`);
  assert.equal(page.title, "Totals & rounding");
  assert.equal(
    page.text,
    [
      "# Totals plan",
      "",
      "Round before converting. Always.",
      "",
      "- Add the helper",
      "",
      "- Wire it in",
      "",
      "```",
      "const x = a < b;",
      "```",
      "",
      "Step\tOwner",
      "",
      "1\tSam",
    ].join("\n"),
  );
  assert.ok(!page.text.includes("Home"), "navigation is not the plan");
  assert.ok(!page.text.includes("Copyright"));
  assert.ok(!page.text.includes("alert"));
});

test("a page with no main part is read from its body, and entities are decoded", () => {
  const page = htmlToText("<html><body><h2>Plan</h2><p>Use &quot;totals&quot; &#8212; &#x27;now&#x27;</p></body></html>");
  assert.equal(page.title, null);
  assert.equal(page.text, "## Plan\n\nUse \"totals\" — 'now'");
});

test("what is not text is refused rather than stored", () => {
  assert.equal(textRefusal("# A plan\n\nwith words"), null);
  assert.match(textRefusal("%PDF-1.4\u0000\u0001binary")!, /not a text file/);
  assert.match(textRefusal("�".repeat(40) + "x".repeat(40))!, /not UTF-8/);
  assert.equal(textRefusal("a�b" + "x".repeat(100)), null, "one stray character in a long file is not a binary");
});

test("files are kept as given, pages are fetched, and the caps are the route's caps", async () => {
  const fetched: string[] = [];
  const fetchPage = async (url: string): Promise<FetchedPage> => {
    fetched.push(url);
    return { url, title: "Design", mime: "text/html", text: "Totals are rounded." };
  };
  const drafts = await collectPlanSources(ENV, [
    { kind: "file", name: "./docs\\plan.md", content: "# Plan\r\n\r\n1. Helper.\r\n" },
    { kind: "website", url: "https://example.test/design" },
  ], fetchPage);
  assert.deepEqual(fetched, ["https://example.test/design"]);
  assert.deepEqual(drafts.map((draft) => [draft.position, draft.kind, draft.name, draft.url, draft.mime, draft.size]), [
    [0, "file", "docs/plan.md", null, "text/markdown", 19],
    [1, "website", "Design", "https://example.test/design", "text/html", 19],
  ]);
  assert.equal(drafts[0]!.content, "# Plan\n\n1. Helper.\n", "line endings are normalised, nothing else is touched");

  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "empty.md", content: " \n" }], fetchPage),
    (err: unknown) => err instanceof PlanSourceRefusal && /empty\.md is empty/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "deck.pdf", content: "%PDF\u0000" }], fetchPage),
    (err: unknown) => err instanceof PlanSourceRefusal && /deck\.pdf cannot be a plan source: it is not a text file/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "website", url: "https://example.test/empty" }], async (url) => ({ url, title: null, mime: "text/html", text: "  " })),
    (err: unknown) => err instanceof PlanSourceRefusal && /no readable text/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "website", url: "https://example.test/long" }], async (url) => ({ url, title: null, mime: "text/html", text: "x".repeat(MAX_SWARM_PLAN_SOURCE_CHARS + 1) })),
    (err: unknown) => err instanceof PlanSourceRefusal && /holds 300,001 characters/.test(err.message),
  );
  const heavy = Array.from({ length: 4 }, (_, i) => ({ kind: "file" as const, name: `${i}.md`, content: "x".repeat(250_001) }));
  await assert.rejects(
    collectPlanSources(ENV, heavy, fetchPage),
    (err: unknown) => err instanceof PlanSourceRefusal && /more than 1,000,000 characters together/.test(err.message),
  );
});

/* ---------------------------------------------------------------- *
 * Fetching an address, against a server of our own.
 * ---------------------------------------------------------------- */

let server: Server;
let origin: string;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/plan") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>The plan</title></head><body><main><h1>Plan</h1><p>Round first.</p></main></body></html>");
    } else if (req.url === "/plan.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Plan\r\n\r\nRound first.\r\n");
    } else if (req.url === "/image") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("y".repeat(9 * 1024 * 1024));
    } else if (req.url === "/away") {
      res.writeHead(302, { location: "/plan" });
      res.end();
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a page is fetched, titled, and reduced to text; a text file is taken as it is", async () => {
  const page = await fetchPlanWebsite(ENV, `${origin}/plan`);
  assert.equal(page.title, "The plan");
  assert.equal(page.mime, "text/html");
  assert.equal(page.text, "# Plan\n\nRound first.");

  const file = await fetchPlanWebsite(ENV, `${origin}/plan.md`);
  assert.equal(file.title, null);
  assert.equal(file.text, "# Plan\n\nRound first.");
});

test("what cannot be a plan is refused with the address and the reason", async () => {
  const refused = async (url: string, reason: RegExp) =>
    assert.rejects(fetchPlanWebsite(ENV, url), (err: unknown) => err instanceof PlanSourceRefusal && reason.test(err.message) && err.message.includes(url));
  await refused(`${origin}/image`, /is image\/png, not a page or a text file/);
  await refused(`${origin}/missing`, /answered 404/);
  await refused(`${origin}/huge`, /larger than 8 MB/);
  await refused(`${origin}/away`, /redirect/);
  await assert.rejects(fetchPlanWebsite(ENV, "not a url"), /is not a web address/);
  await assert.rejects(fetchPlanWebsite(ENV, "ftp://example.test/plan"), /starts with https/);
});

test("in multi mode an address has to be https, said in the plan's own words", async () => {
  await assert.rejects(
    fetchPlanWebsite({ BENTO_MODE: "multi", BETTER_AUTH_URL: "https://bento.test" }, `${origin}/plan`),
    (err: unknown) => err instanceof PlanSourceRefusal && /starts with https:\/\//.test(err.message) && !/MCP/.test(err.message),
  );
});
