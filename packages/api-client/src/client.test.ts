import { test } from "node:test";
import assert from "node:assert/strict";
import { BentoClient } from "./client.js";

test("relatedFeatures names the card in the path", async () => {
  let url = "";
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (input) => {
      url = String(input);
      return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await client.relatedFeatures("11111111-1111-1111-1111-111111111111");
  assert.equal(url, "http://bento.test/api/features/11111111-1111-1111-1111-111111111111/related");
});

function serverWith(builds: (string | null)[], status = 200) {
  const seen: string[] = [];
  let calls = 0;
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async () => {
      const build = builds[Math.min(calls, builds.length - 1)] ?? null;
      calls++;
      return new Response(status === 204 ? null : JSON.stringify({ ok: true }), {
        status,
        headers: {
          "content-type": "application/json",
          ...(build ? { "x-bento-build": build } : {}),
        },
      });
    }) as typeof fetch,
    onBuild: (build) => seen.push(build),
  });
  return { client, seen };
}

test("onBuild fires once per distinct build the server names", async () => {
  const { client, seen } = serverWith(["aaa", "aaa", "bbb", "bbb"]);
  await client.health();
  await client.health();
  await client.health();
  await client.health();
  assert.deepEqual(seen, ["aaa", "bbb"]);
});

test("onBuild stays quiet when responses carry no build", async () => {
  const { client, seen } = serverWith([null]);
  await client.health();
  await client.health();
  assert.deepEqual(seen, []);
});

test("onBuild fires on a refusal too, since a renamed route is a deploy", async () => {
  const { client, seen } = serverWith(["ccc"], 404);
  await assert.rejects(() => client.health());
  assert.deepEqual(seen, ["ccc"]);
});

test("onBuild fires for document requests as well as JSON", async () => {
  const { client, seen } = serverWith(["ddd"]);
  await client.exportPipeline("11111111-1111-1111-1111-111111111111");
  assert.deepEqual(seen, ["ddd"]);
});
