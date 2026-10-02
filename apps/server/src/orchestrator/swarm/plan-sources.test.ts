import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { MAX_SWARM_PLAN_SOURCE_CHARS } from "@bento/core";
import {
  collectPlanSources,
  extractPdfText,
  fetchPlanWebsite,
  htmlToText,
  mediaOf,
  PlanSourceRefusal,
  planSourceFileName,
  textRefusal,
  type FetchedPage,
} from "./plan-sources.js";
import { minimalPdf, ONE_PIXEL_PNG, scannedPdf } from "./plan-sources.fixtures.js";

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
  ], { hasStore: true, fetchPage });
  assert.deepEqual(fetched, ["https://example.test/design"]);
  assert.deepEqual(drafts.map((draft) => [draft.position, draft.kind, draft.name, draft.url, draft.mime, draft.size]), [
    [0, "file", "docs/plan.md", null, "text/markdown", 19],
    [1, "website", "Design", "https://example.test/design", "text/html", 19],
  ]);
  assert.equal(drafts[0]!.content, "# Plan\n\n1. Helper.\n", "line endings are normalised, nothing else is touched");

  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "empty.md", content: " \n" }], { hasStore: true, fetchPage }),
    (err: unknown) => err instanceof PlanSourceRefusal && /empty\.md is empty/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "deck.bin", content: "%BIN\u0000" }], { hasStore: true, fetchPage }),
    (err: unknown) => err instanceof PlanSourceRefusal && /deck\.bin cannot be a plan source: it is not a text file/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "website", url: "https://example.test/empty" }], { hasStore: true, fetchPage: async (url) => ({ url, title: null, mime: "text/html", text: "  " }) }),
    (err: unknown) => err instanceof PlanSourceRefusal && /no readable text/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "website", url: "https://example.test/long" }], { hasStore: true, fetchPage: async (url) => ({ url, title: null, mime: "text/html", text: "x".repeat(MAX_SWARM_PLAN_SOURCE_CHARS + 1) }) }),
    (err: unknown) => err instanceof PlanSourceRefusal && /holds 300,001 characters/.test(err.message),
  );
  const heavy = Array.from({ length: 4 }, (_, i) => ({ kind: "file" as const, name: `${i}.md`, content: "x".repeat(250_001) }));
  await assert.rejects(
    collectPlanSources(ENV, heavy, { hasStore: true, fetchPage }),
    (err: unknown) => err instanceof PlanSourceRefusal && /more than 1,000,000 characters together/.test(err.message),
  );
});

test("a PDF becomes its text and its bytes, an image its bytes alone, and a scan is kept without text", async () => {
  const pdf = minimalPdf(["Totals plan", "1. Add the rounding helper."]);
  assert.equal(await extractPdfText(pdf), "Totals plan\n1. Add the rounding helper.");

  const drafts = await collectPlanSources(ENV, [
    { kind: "file", name: "docs/plan.pdf", mime: "application/pdf", data: pdf.toString("base64") },
    { kind: "file", name: "mockup.png", data: ONE_PIXEL_PNG.toString("base64") },
    { kind: "file", name: "scan.pdf", data: scannedPdf().toString("base64") },
    { kind: "file", name: "notes.md", data: Buffer.from("# Notes\n").toString("base64") },
  ], { hasStore: true });
  assert.deepEqual(drafts.map((draft) => [draft.name, draft.mime, draft.size, draft.content, draft.bytes?.byteLength ?? null]), [
    ["docs/plan.pdf", "application/pdf", 39, "Totals plan\n1. Add the rounding helper.", pdf.byteLength],
    ["mockup.png", "image/png", 0, null, ONE_PIXEL_PNG.byteLength],
    ["scan.pdf", "application/pdf", 0, null, scannedPdf().byteLength],
    ["notes.md", "text/markdown", 8, "# Notes\n", null],
  ]);
  assert.equal(mediaOf("image/jpeg"), "image");
  assert.equal(mediaOf("image/svg+xml"), "text", "SVG is markup an agent reads as text, and a browser must never draw inline");

  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "deck.pdf", data: Buffer.from("not a pdf at all").toString("base64") }], { hasStore: true }),
    (err: unknown) => err instanceof PlanSourceRefusal && /deck\.pdf could not be read as a PDF/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "deck.pdf", content: "%PDF-1.4" }], { hasStore: true }),
    (err: unknown) => err instanceof PlanSourceRefusal && /deck\.pdf is a PDF, and arrived as text/.test(err.message),
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "file", name: "mockup.png", data: ONE_PIXEL_PNG.toString("base64") }], { hasStore: false }),
    (err: unknown) => err instanceof PlanSourceRefusal && /no file storage configured/.test(err.message),
    "a multi mode deploy with no bucket says so rather than storing bytes on a disk a deploy will eat",
  );
  await assert.rejects(
    collectPlanSources(ENV, [{ kind: "website", url: "https://example.test/deck.pdf" }], {
      hasStore: true,
      fetchPage: async (url) => ({ url, title: null, mime: "application/pdf", text: "", bytes: pdf }),
    }).then((rows) => {
      assert.deepEqual(rows.map((row) => [row.kind, row.name, row.url, row.content]), [["website", "deck.pdf", "https://example.test/deck.pdf", "Totals plan\n1. Add the rounding helper."]]);
      throw new Error("ok");
    }),
    /ok/,
    "a PDF at an address takes the same path as an uploaded one, named by its address",
  );
});

test("a source's file name in the workspace is its number and a safe name with an extension", () => {
  const name = (source: Parameters<typeof planSourceFileName>[0]) => planSourceFileName(source);
  assert.equal(name({ position: 0, kind: "file", name: "docs/My Plan (v2).pdf", mime: "application/pdf", url: null }), "1-My_Plan__v2_.pdf");
  assert.equal(name({ position: 2, kind: "website", name: "Totals design", mime: "text/html", url: "https://example.test/design" }), "3-design.html");
  assert.equal(name({ position: 1, kind: "website", name: "Mockup", mime: "image/png", url: "https://example.test/img/mockup.png" }), "2-mockup.png");
  assert.equal(name({ position: 3, kind: "file", name: "../../etc/passwd", mime: "text/plain", url: null }), "4-passwd.txt");
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
    } else if (req.url === "/font") {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.end(Buffer.from([0x77, 0x4f, 0x46, 0x32]));
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
  await refused(`${origin}/font`, /is font\/woff2, not a page, a PDF, an image or a text file/);
  const image = await fetchPlanWebsite(ENV, `${origin}/image`);
  assert.equal(image.mime, "image/png");
  assert.equal(image.text, "");
  assert.ok(image.bytes && image.bytes.byteLength === 4, "an image at an address comes back as its bytes");
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

/* ---------------------------------------------------------------- *
 * The copy in the agent's workspace, written through a real driver.
 * ---------------------------------------------------------------- */

test("every source is copied into the workspace by number, bytes from the store and text as text", async () => {
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { LocalProcessDriver } = await import("@bento/sandbox");
  const { DiskArtifactStore } = await import("../../artifact-store.js");
  const { writePlanSourceFiles, PLAN_SOURCE_DIR } = await import("./plan-sources.js");

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-plan-store-"));
  const workdir = await mkdtemp(path.join(tmpdir(), "bento-plan-workspace-"));
  const store = new DiskArtifactStore(dataDir);
  const pdf = minimalPdf(["Totals plan"]);
  await store.put("org/local/swarm/s1/plan/a", pdf, "application/pdf");
  await store.put("org/local/swarm/s1/plan/b", ONE_PIXEL_PNG, "image/png");

  const driver = new LocalProcessDriver();
  const handle = { provider: "local-process" as const, externalId: "ws", workdir };
  const sources = [
    { id: "a", position: 0, kind: "file" as const, name: "docs/My plan.pdf", url: null, mime: "application/pdf", media: "pdf" as const, size: 11, content: "Totals plan", storageKey: "org/local/swarm/s1/plan/a", byteSize: pdf.byteLength },
    { id: "b", position: 1, kind: "file" as const, name: "mockup.png", url: null, mime: "image/png", media: "image" as const, size: 0, content: null, storageKey: "org/local/swarm/s1/plan/b", byteSize: ONE_PIXEL_PNG.byteLength },
    { id: "c", position: 2, kind: "website" as const, name: "Design", url: "https://example.test/design", mime: "text/html", media: "text" as const, size: 6, content: "# Plan", storageKey: null, byteSize: null },
    { id: "d", position: 3, kind: "file" as const, name: "gone.png", url: null, mime: "image/png", media: "image" as const, size: 0, content: null, storageKey: "org/local/swarm/s1/plan/missing", byteSize: 1 },
  ];
  const paths = await writePlanSourceFiles(driver, store, handle, sources);
  assert.ok(paths);
  assert.deepEqual(
    [...paths.entries()],
    [
      ["a", path.posix.join(workdir, PLAN_SOURCE_DIR, "1-My_plan.pdf")],
      ["b", path.posix.join(workdir, PLAN_SOURCE_DIR, "2-mockup.png")],
      ["c", path.posix.join(workdir, PLAN_SOURCE_DIR, "3-design.html")],
    ],
    "the one whose object is gone has no path, and the rest have theirs",
  );
  assert.deepEqual((await readdir(path.join(workdir, PLAN_SOURCE_DIR))).sort(), ["1-My_plan.pdf", "2-mockup.png", "3-design.html"]);
  assert.equal((await readFile(path.join(workdir, PLAN_SOURCE_DIR, "1-My_plan.pdf"))).equals(pdf), true, "the PDF's bytes, not its text");
  assert.equal((await readFile(path.join(workdir, PLAN_SOURCE_DIR, "2-mockup.png"))).equals(ONE_PIXEL_PNG), true);
  assert.equal(await readFile(path.join(workdir, PLAN_SOURCE_DIR, "3-design.html"), "utf8"), "# Plan");

  // Written again on a later run: the same files, no complaint.
  const again = await writePlanSourceFiles(driver, store, handle, sources);
  assert.equal(again?.size, 3);
});
